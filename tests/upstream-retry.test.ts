import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { ClaudeTerminalError, closeClaudeProcesses, incompleteUpstreamMessage, runClaudeRequest } from "../src/claude-cli.ts";
import { normalizeError } from "../src/stream.ts";

function retryable(errorMessage: string): boolean {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "claude-code-stream-json",
    provider: "claude-code",
    model: "sonnet",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: normalizeError(new Error(errorMessage)),
    timestamp: 0,
  };
  return isRetryableAssistantError(message);
}

test("Pi retries an upstream stream lost before any status", () => {
  const message = incompleteUpstreamMessage({ complete: false, failure: "Error", denied: 0 });
  assert.match(message, /^Incomplete Claude Code upstream response \(status unknown, capture incomplete, relay failure Error\)/);
  assert.equal(retryable(message), true);
});

test("Pi retries an upstream 200 stream cut off mid-response", () => {
  assert.equal(retryable(incompleteUpstreamMessage({ status: 200, complete: false, failure: "Error", denied: 0 })), true);
});

test("Pi retries an upstream 5xx", () => {
  assert.equal(retryable(incompleteUpstreamMessage({ status: 529, complete: false, denied: 0 })), true);
});

test("Pi does not retry an upstream client error", () => {
  const message = incompleteUpstreamMessage({ status: 400, complete: false, denied: 0, upstreamError: "invalid request" });
  assert.equal(retryable(message), false);
});

async function nativeRun(script: string): Promise<{ message: string; detail: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-code-native-")));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "max"}));
  process.exit(0);
}
const emit = (value) => console.log(JSON.stringify(value));
const usage = {input_tokens: 1, output_tokens: 1};
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  if (JSON.parse(line).type !== "user") continue;
  ${script}
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  try {
    await runClaudeRequest({
      model: "sonnet",
      cwd: root,
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
      systemPrompt: "system",
      manifest: [],
      extraBody: { tools: [] },
      toolNames: new Set(),
      env: { PI_CLAUDE_CODE_COMMAND: executable },
      timeoutMs: 5_000,
    });
    throw new Error("request unexpectedly succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { message, detail: error instanceof ClaudeTerminalError ? error.detail : message };
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
}

const complete = (text: string) => `
  emit({type: "stream_event", event: {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}}});
  emit({type: "assistant", error: "server_error", message: {id: "m", role: "assistant", content: [{type: "text", text: ${JSON.stringify(text)}}], usage}});
  emit({type: "assistant", message: {id: "m", role: "assistant", content: [{type: "text", text: "partial"}], stop_reason: "end_turn", usage}});
  emit({type: "stream_event", event: {type: "message_stop"}});
  emit({type: "result", subtype: "error_during_execution", is_error: true, usage});`;

test("Pi retries a native turn whose stream ended before its message", async () => {
  const { message } = await nativeRun(`
  emit({type: "stream_event", event: {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}}});
  emit({type: "result", subtype: "success", is_error: false, usage});`);
  assert.match(message, /^Incomplete Claude Code response: assistant, message_stop and one result required/);
  assert.equal(retryable(message), true);
});

test("Pi retries a native 5xx even when it mentions rate limiting", async () => {
  const { message } = await nativeRun(complete("API Error: 503 server-side rate limit; please retry your request"));
  assert.match(message, /^Claude Code API error: API Error: 503/);
  assert.equal(retryable(message), true);
});

test("Pi does not retry a native turn that reported a client error and no message", async () => {
  const { message, detail } = await nativeRun(`
  emit({type: "assistant", error: "invalid_request", message: {id: "m", role: "assistant", content: [{type: "text", text: "API Error: 400 invalid request"}], usage}});
  emit({type: "result", subtype: "success", is_error: true, usage});`);
  assert.match(detail, /API Error: 400 invalid request/);
  assert.equal(retryable(message), false);
});

test("Pi does not retry a terminal native failure, keeping its text, even when it contains a retry word", async () => {
  const cases: Array<[string, RegExp]> = [
    [`emit({type: "result", subtype: "error_during_execution", is_error: true, errors: ["billing: out of extra usage"], usage});`, /out of extra usage/],
    [`emit({type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 400 invalid request", usage});`, /400 invalid request/],
    [`emit({type: "result", subtype: "success", is_error: true, result: "insufficient_quota", usage});`, /insufficient_quota/],
    [`emit({type: "result", subtype: "error_max_turns", is_error: true, num_turns: 0, usage});`, /error_max_turns/],
    [`emit({type: "result", subtype: "success", is_error: true, result: "API Error: 429 You've hit your limit", usage});`, /hit your limit/],
    [`emit({type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 400 invalid request: timeout must be positive", usage});`, /timeout must be positive/],
  ];
  for (const [script, text] of cases) {
    const { message, detail } = await nativeRun(script);
    assert.equal(retryable(message), false, message);
    assert.doesNotMatch(message, /connection lost/);
    assert.match(detail, text);
  }
  const { message } = await nativeRun(complete("API Error: 400 invalid request: timeout must be positive"));
  assert.equal(retryable(message), false, message);
});

test("Pi does not retry a native plan limit carried on the assistant message", async () => {
  const { message } = await nativeRun(`
  emit({type: "assistant", error: "rate_limit", message: {id: "m", role: "assistant", content: [{type: "text", text: "API Error: 429 You've hit your limit"}], usage}});
  emit({type: "result", subtype: "success", is_error: true, usage});`);
  assert.match(message, /^Claude Code billing: plan or account limit reached/);
  assert.equal(retryable(message), false);
});
