import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { Admission } from "./admission.ts";
import type { DiscoveredClaudeModel } from "./model-catalog.ts";
import type {
  AnthropicStreamEvent,
  NativeFrame,
  NativeMessage,
  NativeOutputEvent,
  NativeResult,
  NativeUsage,
} from "./native-types.ts";
import type { NativeSystemInjection, ToolManifestEntry } from "./transcript.ts";

export const INSTALL_HINT =
  "Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code` " +
  "or set PI_CLAUDE_CODE_COMMAND to the executable.";
export const LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login` and try again.";

export interface ClaudeStatus {
  available: boolean;
  loggedIn: boolean;
  /** True when Claude Code reports a Claude Pro/Max-style subscription login. */
  subscription: boolean;
  authMethod?: string;
  plan?: string;
  detail?: string;
  command?: string;
}

export interface RunClaudeInput {
  model: string;
  /** Working directory exposed to Claude and used for Pi tool paths. */
  cwd?: string;
  frames: NativeFrame[];
  systemPrompt: string;
  manifest: ToolManifestEntry[];
  extraBody: Record<string, unknown>;
  toolNames: Set<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  upstreamUrl?: string;
  /** Native blocks Claude Code injected ahead of the first canonical user message. */
  initialUserPrefix?: unknown[];
  /** Native system messages Claude Code injected immediately after that user message. */
  initialSystemMessages?: unknown[];
  /** Pi system/tool deltas to restore at their historical assistant boundaries. */
  nativeSystemInjections?: NativeSystemInjection[];
  /** Beta features appended to Claude Code's own request header by the admission relay. */
  betas?: string[];
  onEvent?: (event: AnthropicStreamEvent) => void;
}

export interface RunClaudeOutput {
  message: NativeMessage;
  result: NativeResult;
  usage: NativeUsage;
  exitCode: number;
  admission: {
    upstreamRequests: number;
    blockedRequests: number;
    requestId?: string;
  };
  initialUserPrefix?: unknown[];
  initialSystemMessages?: unknown[];
}

function configuredCommand(env: Record<string, string | undefined>): string {
  return env.PI_CLAUDE_CODE_COMMAND || "claude";
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const command = configuredCommand(env);
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return (await executable(candidate)) ? candidate : undefined;
  }

  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").flatMap((suffix) => [suffix, suffix.toLowerCase()])
      : [""];
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of extensions) {
      const candidate = join(directory, process.platform === "win32" && extname(command) ? command : command + suffix);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function withConfigDirectory(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) output[key] = value;
  if (output.PI_CLAUDE_CODE_CONFIG_DIR) output.CLAUDE_CONFIG_DIR = output.PI_CLAUDE_CODE_CONFIG_DIR;
  return output;
}

async function captureProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawnCommand(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-1_000_000)));
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const code = await childExit(child);
    signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function getClaudeStatus(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<ClaudeStatus> {
  const env = withConfigDirectory(envInput);
  const command = await resolveClaudeExecutable(env);
  if (!command) return { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT };
  try {
    const result = await captureProcess(command, ["auth", "status"], env, signal);
    const payload = result.stdout.trim().startsWith("{")
      ? (JSON.parse(result.stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown })
      : {};
    const loggedIn = payload.loggedIn === true;
    const plan = typeof payload.subscriptionType === "string" ? payload.subscriptionType : undefined;
    return {
      available: true,
      loggedIn,
      subscription: loggedIn && !!plan,
      command,
      authMethod: typeof payload.authMethod === "string" ? payload.authMethod : undefined,
      plan,
      detail: loggedIn ? undefined : LOGIN_HINT,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: true, loggedIn: false, subscription: false, command, detail: LOGIN_HINT };
  }
}

/** Run Claude Code's own browser login while Pi renders the URL and code prompt. */
export async function loginClaudeCode(
  interaction: ProviderAuthInteraction,
  envInput: Record<string, string | undefined> = process.env,
): Promise<ClaudeStatus> {
  interaction.signal.throwIfAborted();
  const env = withConfigDirectory({ ...process.env, ...envInput });
  const command = await resolveClaudeExecutable(env);
  if (!command) throw new Error(INSTALL_HINT);

  interaction.notify({ type: "progress", message: "Starting Claude Code subscription login…" });
  const child = spawnCommand(command, ["auth", "login", "--claudeai"], {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  let sawUrl = false;
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const inspectOutput = (chunk: string) => {
    stdout = (stdout + chunk).slice(-65_536);
    if (sawUrl) return;
    const match = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x07\x1b]+/u.exec(stdout);
    if (match) {
      sawUrl = true;
      resolveUrl(match[0]);
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", inspectOutput);
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));
  child.once("error", (error) => rejectUrl(error));
  child.once("exit", (code) => {
    if (!sawUrl) rejectUrl(new Error(`Claude Code login exited before presenting an authorization URL (${code})`));
  });

  const abort = () => killProcessTree(child);
  interaction.signal.addEventListener("abort", abort, { once: true });
  const exitPromise = childExit(child);
  try {
    const url = await urlPromise;
    // Claude Code opens the browser itself. Show the captured URL as a
    // fallback without asking Pi to open a duplicate browser tab.
    interaction.notify({
      type: "info",
      message: "Claude Code opened a browser for subscription login.",
      links: [{ url, label: "Open the authorization page" }],
    });
    const promptAbort = new AbortController();
    const promptOutcome = interaction
      .prompt({
        type: "manual_code",
        message: "Paste the authorization code shown after signing in (only if requested)",
        signal: promptAbort.signal,
      })
      .then(
        (code) => ({ kind: "code" as const, code }),
        (error: unknown) => ({ kind: "prompt-error" as const, error }),
      );
    const exitOutcome = exitPromise.then(
      (code) => ({ kind: "exit" as const, code }),
      (error: unknown) => ({ kind: "exit-error" as const, error }),
    );
    const first = await Promise.race([promptOutcome, exitOutcome]);

    let exitCode: number;
    if (first.kind === "exit") {
      // Browser callback completed the CLI flow. Abort Pi's optional manual
      // input so the login dialog dismisses immediately.
      promptAbort.abort();
      exitCode = first.code;
    } else if (first.kind === "exit-error") {
      promptAbort.abort();
      throw first.error;
    } else if (first.kind === "prompt-error") {
      throw first.error;
    } else {
      interaction.signal.throwIfAborted();
      if (!first.code.trim()) throw new Error("Claude Code login returned an empty authorization code");
      child.stdin?.end(`${first.code.trim()}\n`);
      interaction.notify({ type: "progress", message: "Completing Claude Code login…" });
      const completed = await exitOutcome;
      if (completed.kind === "exit-error") throw completed.error;
      exitCode = completed.code;
    }

    interaction.signal.throwIfAborted();
    if (exitCode !== 0) {
      const detail = (stderr || stdout).trim().slice(-500);
      throw new Error(`Claude Code login failed${detail ? `: ${detail}` : ""}`);
    }
    const status = await getClaudeStatus(env, interaction.signal);
    if (!status.loggedIn) throw new Error(LOGIN_HINT);
    if (!status.subscription) {
      throw new Error("Claude Code logged in without a Claude subscription; retry with `claude auth login --claudeai`");
    }
    return status;
  } finally {
    interaction.signal.removeEventListener("abort", abort);
    if (child.exitCode === null) killProcessTree(child);
  }
}

function isDiscoveredModel(value: unknown): value is DiscoveredClaudeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<DiscoveredClaudeModel>;
  return (
    typeof model.value === "string" &&
    typeof model.displayName === "string" &&
    typeof model.description === "string" &&
    (model.resolvedModel === undefined || typeof model.resolvedModel === "string")
  );
}

/** Ask the installed Claude Code process for the account's selectable model catalog. */
export async function discoverClaudeModels(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<DiscoveredClaudeModel[]> {
  signal?.throwIfAborted();
  const env = processEnvironment(envInput, {});
  const command = await resolveClaudeExecutable(env);
  if (!command) throw new Error(INSTALL_HINT);

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "default",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
  const child = spawnCommand(command, args, {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);

  const requestId = `pi-models-${Date.now()}`;
  child.stdin?.write(
    `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
  );
  child.stdin?.end(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "model-catalog-probe" }] },
      shouldQuery: false,
    })}\n`,
  );

  let models: DiscoveredClaudeModel[] | undefined;
  try {
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "control_response") continue;
      const envelope = event.response as Record<string, unknown> | undefined;
      if (envelope?.request_id !== requestId || envelope.subtype !== "success") continue;
      const response = envelope.response as Record<string, unknown> | undefined;
      if (Array.isArray(response?.models)) models = response.models.filter(isDiscoveredModel);
    }
    const exitCode = await childExit(child);
    signal?.throwIfAborted();
    if (timedOut) throw new Error("Claude Code model discovery timed out");
    if (exitCode !== 0) throw new Error(`Claude Code model discovery failed${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`);
    if (!models?.length) throw new Error("Claude Code returned no selectable models");
    return models;
  } catch (error) {
    if (timedOut) throw new Error("Claude Code model discovery timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) killProcessTree(child);
  }
}

function spawnCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const comspec = options?.env?.COMSPEC || process.env.COMSPEC || "cmd.exe";
    const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
    return spawn(comspec, ["/d", "/s", "/c", [quote(command), ...args.map(quote)].join(" ")], options);
  }
  return spawn(command, args, options);
}

function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else reject(new Error(`Claude Code exited from signal ${signal ?? "unknown"}`));
    });
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // It exited between the checks.
    }
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined> {
    if (this.values.length) return this.values.shift();
    if (this.ended) {
      if (this.failure) throw this.failure;
      return undefined;
    }
    signal?.throwIfAborted();

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        fn();
      };
      const waiter = (item: IteratorResult<T>) =>
        finish(() => {
          if (item.done && this.failure) reject(this.failure);
          else resolve(item.done ? undefined : item.value);
        });
      const onAbort = () => finish(() => reject(signal?.reason ?? new Error("Claude Code request aborted")));
      const timer = setTimeout(() => finish(() => reject(new Error("Claude Code stream timed out"))), timeoutMs);
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function conflictingEnvironment(env: Record<string, string>): string[] {
  const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"].filter(
    (key) => !!env[key],
  );
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (env[key] && !["0", "false", "no", "off"].includes(env[key]!.toLowerCase())) conflicts.push(key);
  }
  return conflicts;
}

function processEnvironment(
  input: Record<string, string | undefined> | undefined,
  extraBody: Record<string, unknown>,
): Record<string, string> {
  const env = withConfigDirectory({ ...process.env, ...input });
  const conflicts = conflictingEnvironment(env);
  if (conflicts.length) {
    throw new Error(`Claude Code subscription provider refuses conflicting auth/backend overrides: ${conflicts.join(", ")}`);
  }
  delete env.CLAUDE_CODE_EXTRA_BODY;
  Object.assign(env, {
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  if (typeof extraBody.max_tokens === "number") env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(extraBody.max_tokens);
  return env;
}

async function writeFrame(child: ChildProcess, frame: NativeFrame): Promise<void> {
  if (!child.stdin?.writable) throw new Error("Claude Code stdin closed during history replay");
  if (!child.stdin.write(`${JSON.stringify(frame)}\n`)) {
    await new Promise<void>((resolve, reject) => {
      child.stdin!.once("drain", resolve);
      child.stdin!.once("error", reject);
    });
  }
}

function nativeErrorText(event: Extract<NativeOutputEvent, { type: "assistant" }>): string | undefined {
  const messageError = (event.message as Record<string, unknown>).error;
  if (!event.error && !messageError) return undefined;
  return event.message.content
    .filter((block): block is Extract<(typeof event.message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "cache_control") output[key] = withoutCacheControl(child);
  }
  return output;
}

interface NativeRequestMessage {
  role?: string;
  content?: unknown;
}

function requestMessages(body: Buffer | undefined): NativeRequestMessage[] | undefined {
  if (!body) return undefined;
  try {
    const payload = JSON.parse(body.toString("utf8")) as { messages?: unknown };
    return Array.isArray(payload.messages) ? (payload.messages as NativeRequestMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

function deriveInitialUserPrefix(body: Buffer | undefined, canonicalContent: unknown[]): unknown[] | undefined {
  if (canonicalContent.length === 0) return undefined;
  const actual = requestMessages(body)?.[0];
  if (actual?.role !== "user" || !Array.isArray(actual.content) || actual.content.length < canonicalContent.length) {
    return undefined;
  }
  const suffix = actual.content.slice(-canonicalContent.length).map(withoutCacheControl);
  if (JSON.stringify(suffix) !== JSON.stringify(canonicalContent.map(withoutCacheControl))) return undefined;
  return structuredClone(actual.content.slice(0, -canonicalContent.length));
}

function deriveInitialSystemMessages(body: Buffer | undefined): unknown[] | undefined {
  const messages = requestMessages(body);
  if (messages?.[0]?.role !== "user") return undefined;
  let end = 1;
  while (messages[end]?.role === "system") end += 1;
  const systems = messages.slice(1, end);

  // A replayed history from an older carrier has the date reminder at the
  // moving tail rather than in the initial environment reminder. Snapshot it
  // beside the environment so the next request has a stable prefix.
  let trailingStart = messages.length;
  while (trailingStart > end && messages[trailingStart - 1]?.role === "system") trailingStart -= 1;
  if (trailingStart < messages.length) systems.push(...messages.slice(trailingStart));
  return systems.length ? structuredClone(systems) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
        ? ((block as Record<string, unknown>).text as string)
        : "",
    )
    .join("");
}

function setCacheBreakpoint(message: NativeRequestMessage): void {
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content.at(-1);
  if (!last || typeof last !== "object") return;
  (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
}

function setReplayCacheBreakpoints(messages: NativeRequestMessage[]): void {
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length >= 3) {
    // Claude permits four cache breakpoints. Its two system-prompt markers
    // consume half of them, so once a prior queried user exists, move the
    // native environment marker to that exact previous query boundary. This
    // avoids relying on automatic lookback (notably unreliable with images).
    for (const message of messages) {
      if (message.role === "system") message.content = withoutCacheControl(message.content);
    }
    setCacheBreakpoint(messages[userIndexes.at(-2)!]!);
  }
  const final = messages.at(-1);
  if (final) setCacheBreakpoint(final);
}

function removeRepeatedUserReminders(messages: NativeRequestMessage[], prefix: unknown[] | undefined): void {
  const reminder = contentText(prefix).trimEnd();
  if (!reminder || !prefix) return;
  const normalizedPrefix = JSON.stringify(prefix.map(withoutCacheControl));

  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const leading = message.content.slice(0, prefix.length).map(withoutCacheControl);
    if (JSON.stringify(leading) === normalizedPrefix) message.content.splice(0, prefix.length);

    const toolResult = message.content.findLast(
      (block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result",
    ) as Record<string, unknown> | undefined;
    if (!toolResult) continue;

    const suffix = `\n${reminder}`;
    if (typeof toolResult.content === "string" && toolResult.content.endsWith(suffix)) {
      toolResult.content = toolResult.content.slice(0, -suffix.length);
    } else if (Array.isArray(toolResult.content)) {
      const final = toolResult.content.at(-1) as Record<string, unknown> | undefined;
      if (final?.type === "text" && typeof final.text === "string") {
        if (final.text === reminder) toolResult.content.pop();
        else if (final.text.endsWith(suffix)) final.text = final.text.slice(0, -suffix.length);
      }
    }
  }
}

function injectNativeSystemMessages(
  messages: NativeRequestMessage[],
  injections: NativeSystemInjection[],
): NativeRequestMessage[] {
  const byAssistant = new Map<number, NativeRequestMessage[]>();
  const trailing: NativeRequestMessage[] = [];
  for (const injection of injections) {
    const message = { role: "system", content: structuredClone(injection.content) };
    if (injection.beforeAssistant === null) trailing.push(message);
    else {
      const pending = byAssistant.get(injection.beforeAssistant) ?? [];
      pending.push(message);
      byAssistant.set(injection.beforeAssistant, pending);
    }
  }

  const output: NativeRequestMessage[] = [];
  let assistantOrdinal = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      output.push(...(byAssistant.get(assistantOrdinal) ?? []));
      byAssistant.delete(assistantOrdinal);
      assistantOrdinal += 1;
    }
    output.push(message);
  }
  if (byAssistant.size > 0) throw new Error("Claude Code request lost an assistant boundary needed by system history");
  output.push(...trailing);
  return output;
}

function normalizeLeadingSystemCache(system: unknown): void {
  if (!Array.isArray(system)) return;
  for (const block of system) {
    if (block && typeof block === "object") delete (block as Record<string, unknown>).cache_control;
  }
  const last = system.at(-1);
  if (last && typeof last === "object") {
    (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
  }
}

export function rewriteInitialRequest(
  body: Buffer,
  prefix: unknown[] | undefined,
  canonicalContent: unknown[],
  initialSystemMessages: unknown[] | undefined,
  nativeSystemInjections?: NativeSystemInjection[],
): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as {
    messages?: NativeRequestMessage[];
    system?: unknown;
  };
  let messages = payload.messages;
  const first = messages?.[0];
  if (first?.role !== "user" || !Array.isArray(first.content)) {
    throw new Error("Claude Code request is missing its initial user message");
  }
  if (prefix) first.content = [...structuredClone(prefix), ...structuredClone(canonicalContent)];

  if (initialSystemMessages?.length && messages) {
    let systemEnd = 1;
    while (messages[systemEnd]?.role === "system") systemEnd += 1;
    messages.splice(1, systemEnd - 1, ...(structuredClone(initialSystemMessages) as NativeRequestMessage[]));

    const initialText = initialSystemMessages
      .map((message) => contentText((message as NativeRequestMessage).content))
      .join("\n");
    while (messages.at(-1)?.role === "system") {
      const trailingText = contentText(messages.at(-1)?.content);
      if (!trailingText || !initialText.includes(trailingText)) break;
      messages.pop();
    }
    removeRepeatedUserReminders(messages, prefix);
  }

  if (nativeSystemInjections) {
    messages = injectNativeSystemMessages(messages!, nativeSystemInjections);
    payload.messages = messages;
    normalizeLeadingSystemCache(payload.system);
  }
  if (initialSystemMessages?.length || nativeSystemInjections) setReplayCacheBreakpoints(messages!);

  return Buffer.from(JSON.stringify(payload));
}

export async function runClaudeRequest(input: RunClaudeInput): Promise<RunClaudeOutput> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  input.signal?.throwIfAborted();
  const effectiveInputEnv = { ...process.env, ...input.env };
  const status = await getClaudeStatus(effectiveInputEnv, input.signal);
  if (!status.available || !status.command) throw new Error(INSTALL_HINT);
  if (!status.loggedIn) throw new Error(LOGIN_HINT);

  const env = processEnvironment(input.env, input.extraBody);
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-"));
  const toolsPath = join(root, "tools.json");
  const settingsPath = join(root, "settings.json");
  const systemPath = join(root, "system.md");
  const inertMcpPath = fileURLToPath(new URL("./inert-mcp.mjs", import.meta.url));
  let child: ChildProcess | undefined;
  let admission: Admission | undefined;
  let stderr = "";

  try {
    await Promise.all([
      writeFile(toolsPath, JSON.stringify(input.manifest), "utf8"),
      writeFile(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(input.extraBody) } }), "utf8"),
      writeFile(systemPath, input.systemPrompt, "utf8"),
    ]);

    let sawMessageStop = false;
    const deliver = (event: AnthropicStreamEvent) => {
      if (event.type === "message_stop") sawMessageStop = true;
      input.onEvent?.(event);
    };
    const canonicalInitialUser = input.frames.find((frame) => frame.type === "user")?.message.content ?? [];
    admission = new Admission(
      input.upstreamUrl ?? "https://api.anthropic.com",
      timeoutMs,
      deliver,
      input.initialUserPrefix || input.initialSystemMessages || input.nativeSystemInjections
        ? (body) =>
            rewriteInitialRequest(
              body,
              input.initialUserPrefix,
              canonicalInitialUser,
              input.initialSystemMessages,
              input.nativeSystemInjections,
            )
        : undefined,
      input.betas,
    );
    env.ANTHROPIC_BASE_URL = await admission.start();

    const mcp = {
      mcpServers: {
        pi: { command: process.execPath, args: [inertMcpPath, toolsPath] },
      },
    };
    const args = [
      "-p",
      "--model",
      input.model,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--system-prompt-file",
      systemPath,
      "--settings",
      settingsPath,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--max-turns",
      "1",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--mcp-config",
      JSON.stringify(mcp),
    ];

    child = spawnCommand(status.command, args, {
      // Claude Code tells the model its process cwd. Running in the transport
      // directory makes it ask Pi's tools to inspect an already-deleted temp
      // path. Keep only transport files private; expose Pi's real cwd here.
      cwd: input.cwd ?? process.cwd(),
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

    const queue = new AsyncQueue<NativeOutputEvent>();
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const readTask = (async () => {
      try {
        for await (const line of reader) {
          if (!line.trim()) continue;
          try {
            queue.push(JSON.parse(line) as NativeOutputEvent);
          } catch (error) {
            throw new Error(`Invalid Claude Code stream-json output: ${line.slice(0, 300)}`, { cause: error });
          }
        }
        queue.end();
      } catch (error) {
        queue.end(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    const exitPromise = childExit(child);
    const abort = () => {
      admission?.abort();
      if (child) killProcessTree(child);
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    const assistants: NativeMessage[] = [];
    const results: NativeResult[] = [];
    let nativeError: string | undefined;

    try {
      for (const frame of input.frames) {
        await writeFrame(child, frame);
        if (frame.shouldQuery === false) {
          for (;;) {
            const event = await queue.next(input.signal, timeoutMs);
            if (!event) throw new Error("Claude Code exited before acknowledging history replay");
            if (event.type === "result") {
              if (event.num_turns !== 0 || event.is_error) {
                throw new Error("Claude Code rejected zero-turn history replay");
              }
              break;
            }
          }
        }
      }
      child.stdin?.end();

      for (;;) {
        const event = await queue.next(input.signal, timeoutMs);
        if (!event) break;
        if (event.type === "assistant") {
          const error = nativeErrorText(event);
          if (error !== undefined) nativeError = error;
          else assistants.push(event.message);
        } else if (event.type === "result") {
          results.push(event);
        } else if (event.type === "stream_event" && !admission.used) {
          deliver(event.event);
        }
      }
      await readTask;
      const exitCode = await exitPromise;
      await admission.settled();
      input.signal?.throwIfAborted();

      let message: NativeMessage | undefined;
      if (admission.used) {
        if (admission.status !== 200 || !admission.capture.complete || !admission.capture.message) {
          let detail = `status ${admission.status ?? "unknown"}, capture ${admission.capture.complete ? "complete" : "incomplete"}`;
          if (admission.failure) detail += `, relay failure ${admission.failure}`;
          if (admission.denied) detail += `, native retries denied ${admission.denied}`;
          const upstreamError = admission.errorText();
          if (upstreamError) detail += `, upstream said: ${upstreamError.slice(0, 500)}`;
          throw new Error(`Incomplete Claude Code upstream response (${detail})`);
        }
        message = admission.capture.message;
        sawMessageStop = true;
      } else {
        message = assistants.at(-1);
      }

      const result = results.at(-1);
      if (results.length !== 1 || !message || !sawMessageStop || !result) {
        throw new Error(
          `Incomplete Claude Code response: assistant, message_stop and one result required${stderr ? ` (${stderr.trim().slice(-500)})` : ""}`,
        );
      }

      const nativeFailureHandled = admission.denied > 0 || message.stop_reason === "refusal";
      if (nativeError && !nativeFailureHandled) throw new Error(`Claude Code API error: ${nativeError}`);
      const hasTools = message.content.some((block) => block.type === "tool_use");
      const maxTurnsBoundary = hasTools && result.subtype === "error_max_turns" && exitCode === 1;
      if (!maxTurnsBoundary && !nativeFailureHandled && (exitCode !== 0 || result.is_error || result.subtype !== "success")) {
        throw new Error(`Claude Code request failed: ${result.subtype ?? `exit ${exitCode}`}`);
      }

      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        if (!block.name.startsWith("mcp__pi__") || !input.toolNames.has(block.name.slice("mcp__pi__".length))) {
          throw new Error("Claude Code returned a tool outside Pi's current tool inventory");
        }
      }

      const usage = message.usage ?? result.usage;
      if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
        throw new Error("Claude Code response did not include complete token usage");
      }

      return {
        message,
        result,
        usage,
        exitCode,
        admission: {
          upstreamRequests: Number(admission.used),
          blockedRequests: admission.denied,
          requestId: admission.requestId,
        },
        initialUserPrefix:
          input.initialUserPrefix ?? deriveInitialUserPrefix(admission.originalRequestBody, canonicalInitialUser),
        initialSystemMessages:
          input.initialSystemMessages ?? deriveInitialSystemMessages(admission.originalRequestBody),
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  } finally {
    admission?.abort();
    if (child && child.exitCode === null) killProcessTree(child);
    await admission?.close();
    await rm(root, { recursive: true, force: true });
  }
}
