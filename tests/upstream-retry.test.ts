import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { incompleteUpstreamMessage } from "../src/claude-cli.ts";
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
