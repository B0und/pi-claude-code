import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import {
  buildExtraBody,
  getInitialSystemMessages,
  getInitialUserPrefix,
  makeReplayDiagnostic,
  normalizeInputSchema,
  prepareFrames,
  prepareTools,
  TOOL_PREFIX,
} from "../src/transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("prepares replay frames and groups tool results", () => {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "test",
    provider: "claude-code",
    model: "sonnet",
    content: [
      { type: "thinking", thinking: "private", thinkingSignature: "signed" },
      { type: "text", text: "checking" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
  const messages: Message[] = [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "inspect", timestamp: 1 },
    assistant,
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "A" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "read",
      content: [{ type: "text", text: "B" }],
      isError: false,
      timestamp: 2,
    },
  ];

  const frames = prepareFrames(messages);
  assert.equal(frames.length, 3);
  assert.equal(frames[0]?.shouldQuery, false);
  assert.equal(frames[1]?.type, "assistant");
  assert.equal((frames[1]?.message.content[2] as { name: string }).name, `${TOOL_PREFIX}read`);
  assert.equal(frames[2]?.message.content.length, 2);
  assert.equal(frames[2]?.shouldQuery, undefined);
});

test("replays native signed blocks only while the visible projection is unchanged", () => {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "test",
    provider: "claude-code",
    model: "sonnet",
    content: [
      { type: "thinking", thinking: "private", thinkingSignature: "signed" },
      { type: "text", text: "visible" },
    ],
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
  const native = {
    id: "m1",
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "private", signature: "signed", extra: "preserved" },
      { type: "text" as const, text: "visible" },
    ],
    stop_reason: "end_turn",
  };
  const nativePrefix = [{ type: "text", text: "<system-reminder>stable</system-reminder>" }];
  const nativeSystems = [{ role: "system", content: [{ type: "text", text: "environment" }] }];
  assistant.diagnostics = [makeReplayDiagnostic(native, assistant, nativePrefix, nativeSystems) as never];

  assert.deepEqual(getInitialUserPrefix([assistant]), nativePrefix);
  assert.deepEqual(getInitialSystemMessages([assistant]), nativeSystems);
  const original = prepareFrames([
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "user", content: "again", timestamp: 2 },
  ]);
  assert.equal((original[1]?.message.content[0] as { extra?: string }).extra, "preserved");

  assistant.content[1] = { type: "text", text: "edited" };
  const edited = prepareFrames([
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "user", content: "again", timestamp: 2 },
  ]);
  assert.deepEqual(edited[1]?.message.content, [{ type: "text", text: "edited" }]);
});

test("normalizes tool schemas and builds native generation fields", () => {
  const tools = [
    {
      name: "probe",
      description: "probe",
      parameters: {
        type: "object",
        properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
        required: ["value"],
      },
    },
  ] as unknown as Tool[];
  const prepared = prepareTools(tools);
  assert.equal(prepared.manifest[0]?.name, "probe");
  assert.equal(prepared.nativeTools[0]?.name, `${TOOL_PREFIX}probe`);
  assert.deepEqual(
    normalizeInputSchema({ oneOf: [{ type: "object" }, { type: "string" }] }),
    { type: "object", properties: {} },
  );
  assert.deepEqual(buildExtraBody("claude-sonnet-5", prepared.nativeTools, { reasoning: "minimal" }), {
    tools: prepared.nativeTools,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  });
  assert.deepEqual(buildExtraBody("claude-haiku-4-5-20251001", [], {}), {
    tools: [],
    thinking: { type: "disabled" },
    context_management: { edits: [] },
  });
});
