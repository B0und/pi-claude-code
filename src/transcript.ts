import type {
  AssistantMessage,
  ImageContent,
  Message,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { supportsAdaptiveThinking } from "./model-catalog.ts";
import type { NativeContentBlock, NativeFrame, NativeMessage } from "./native-types.ts";

export const TOOL_PREFIX = "mcp__pi__";
export const NATIVE_REPLAY_DIAGNOSTIC = "claude-code.native-assistant.v1";

interface ReplayCarrier {
  version: 1;
  message: NativeMessage;
  projection: AssistantProjection;
  initialUserPrefix?: unknown[];
  initialSystemMessages?: unknown[];
}

interface AssistantProjection {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assistantProjection(message: AssistantMessage): AssistantProjection {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const toolCalls = message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ id: block.id, name: block.name, input: clone(block.arguments) as Record<string, unknown> }));
  return { text, toolCalls };
}

function isReplayCarrier(value: unknown): value is ReplayCarrier {
  if (!value || typeof value !== "object") return false;
  const carrier = value as Partial<ReplayCarrier>;
  return carrier.version === 1 && !!carrier.message && !!carrier.projection;
}

function replayCarrier(message: AssistantMessage): ReplayCarrier | undefined {
  const diagnostic = message.diagnostics?.find((item) => item.type === NATIVE_REPLAY_DIAGNOSTIC);
  const candidate = diagnostic?.details?.carrier;
  return isReplayCarrier(candidate) ? candidate : undefined;
}

function replayMetadata(messages: Message[], key: "initialUserPrefix" | "initialSystemMessages"): unknown[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const value = replayCarrier(message)?.[key];
    if (value) return clone(value);
  }
  return undefined;
}

export function getInitialUserPrefix(messages: Message[]): unknown[] | undefined {
  return replayMetadata(messages, "initialUserPrefix");
}

export function getInitialSystemMessages(messages: Message[]): unknown[] | undefined {
  return replayMetadata(messages, "initialSystemMessages");
}

function projectionsEqual(left: AssistantProjection, right: AssistantProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function imageBlock(block: ImageContent): Record<string, unknown> {
  return {
    type: "image",
    source: { type: "base64", media_type: block.mimeType, data: block.data },
  };
}

function userContent(content: string | (TextContent | ImageContent)[]): unknown[] {
  if (typeof content === "string") return content ? [{ type: "text", text: sanitizeSurrogates(content) }] : [];
  return content.map((block) =>
    block.type === "text" ? { type: "text", text: sanitizeSurrogates(block.text) } : imageBlock(block),
  );
}

function toolResultContent(message: ToolResultMessage): string | unknown[] {
  const hasImages = message.content.some((block) => block.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(
      message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  }
  return message.content.map((block) =>
    block.type === "text" ? { type: "text", text: sanitizeSurrogates(block.text) } : imageBlock(block),
  );
}

function canonicalAssistantContent(message: AssistantMessage): NativeContentBlock[] {
  const blocks: NativeContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) {
      blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
    } else if (block.type === "thinking" && block.thinking.trim() && block.thinkingSignature) {
      if (block.redacted) {
        blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
      } else {
        blocks.push({
          type: "thinking",
          thinking: sanitizeSurrogates(block.thinking),
          signature: block.thinkingSignature,
        });
      }
    } else if (block.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: `${TOOL_PREFIX}${block.name}`,
        input: clone(block.arguments) as Record<string, unknown>,
      });
    }
  }
  return blocks;
}

function assistantContent(message: AssistantMessage): NativeContentBlock[] {
  const carrier = replayCarrier(message);
  if (carrier && projectionsEqual(assistantProjection(message), carrier.projection)) {
    return clone(carrier.message.content);
  }

  // A changed projection must not restore stale signed thinking. For messages
  // produced by this provider without a carrier (for example an old session),
  // canonical signed blocks are still the best available replay.
  if (carrier) {
    return canonicalAssistantContent({
      ...message,
      content: message.content.filter((block) => block.type !== "thinking"),
    });
  }
  return canonicalAssistantContent(message);
}

export function prepareFrames(messages: Message[]): NativeFrame[] {
  const frames: NativeFrame[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    let role: "user" | "assistant";
    let blocks: unknown[];

    if (message.role === "user") {
      role = "user";
      blocks = userContent(message.content);
    } else if (message.role === "assistant") {
      role = "assistant";
      blocks = assistantContent(message);
    } else {
      role = "user";
      blocks = [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: toolResultContent(message),
          is_error: message.isError,
        },
      ];
    }

    if (blocks.length === 0) continue;
    const previous = frames.at(-1);
    if (role === "user" && previous?.type === "user") {
      previous.message.content.push(...blocks);
    } else {
      frames.push({ type: role, message: { role, content: blocks } });
    }
  }

  const final = frames.at(-1);
  if (!final || final.type !== "user" || final.message.content.length === 0) {
    throw new Error("Claude Code history must end in a non-empty user or tool-result message");
  }

  for (let index = 0; index < frames.length - 1; index++) {
    if (frames[index]?.type === "user") frames[index]!.shouldQuery = false;
  }
  return frames;
}

function withoutNullVariant(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutNullVariant);
  if (!schema || typeof schema !== "object") return schema;

  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) output[key] = withoutNullVariant(value);

  if (Array.isArray(output.type) && output.type.includes("null")) {
    const remaining = output.type.filter((value) => value !== "null");
    output.type = remaining.length === 1 ? remaining[0] : remaining;
  }

  if (Array.isArray(output.anyOf)) {
    const nonNull = output.anyOf.filter(
      (branch) => !(branch && typeof branch === "object" && (branch as Record<string, unknown>).type === "null"),
    );
    if (nonNull.length === 1 && nonNull.length !== output.anyOf.length) {
      const replacement = nonNull[0];
      delete output.anyOf;
      if (replacement && typeof replacement === "object") Object.assign(output, replacement);
    }
  }
  return output;
}

export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const normalized = withoutNullVariant(schema) as Record<string, unknown>;
  for (const key of ["oneOf", "allOf", "anyOf"]) delete normalized[key];
  if (!normalized.type) normalized.type = "object";
  if (normalized.type === "object" && (!normalized.properties || typeof normalized.properties !== "object")) {
    normalized.properties = {};
  }
  return normalized;
}

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function prepareTools(tools: Tool[]): {
  manifest: ToolManifestEntry[];
  nativeTools: Array<Record<string, unknown>>;
  names: Set<string>;
} {
  const names = new Set<string>();
  const manifest: ToolManifestEntry[] = [];
  const nativeTools: Array<Record<string, unknown>> = [];

  for (const tool of tools) {
    if (!/^[A-Za-z0-9_-]{1,50}$/u.test(tool.name) || names.has(tool.name)) {
      throw new Error("Claude Code tool names must be unique ASCII identifiers of at most 50 characters");
    }
    names.add(tool.name);
    const schema = normalizeInputSchema(tool.parameters);
    manifest.push({ name: tool.name, description: tool.description, inputSchema: schema });
    nativeTools.push({
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      input_schema: schema,
    });
  }
  return { manifest, nativeTools, names };
}

export function buildExtraBody(
  modelId: string,
  nativeTools: Array<Record<string, unknown>>,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { tools: nativeTools };
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

  if (options?.reasoning) {
    if (supportsAdaptiveThinking(modelId)) body.thinking = { type: "adaptive" };
    body.output_config = {
      effort: options.reasoning === "minimal" ? "low" : options.reasoning,
    };
  } else {
    body.thinking = { type: "disabled" };
    // Native clear-thinking edits are invalid when thinking is disabled.
    body.context_management = { edits: [] };
  }
  return body;
}

export function makeReplayDiagnostic(
  message: NativeMessage,
  output: AssistantMessage,
  initialUserPrefix?: unknown[],
  initialSystemMessages?: unknown[],
) {
  return {
    type: NATIVE_REPLAY_DIAGNOSTIC,
    timestamp: Date.now(),
    details: {
      carrier: {
        version: 1,
        message: clone(message),
        projection: assistantProjection(output),
        ...(initialUserPrefix ? { initialUserPrefix: clone(initialUserPrefix) } : {}),
        ...(initialSystemMessages ? { initialSystemMessages: clone(initialSystemMessages) } : {}),
      },
    },
  };
}
