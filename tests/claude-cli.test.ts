import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverClaudeModels, loginClaudeCode, rewriteInitialRequest, runClaudeRequest } from "../src/claude-cli.ts";
import { createClaudeCodeProvider } from "../src/provider.ts";

test("stabilizes Claude Code's native replay reminders and cache breakpoint", () => {
  const canonical = [{ type: "text", text: "inspect" }];
  const prefix = [{ type: "text", text: "account reminder" }];
  const initialSystemMessages = [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: "environment reminder\ndate reminder",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    },
  ];
  const current = {
    messages: [
      { role: "user", content: [{ type: "text", text: "changed reminder" }, ...canonical] },
      { role: "system", content: "environment reminder" },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: [...prefix, { type: "text", text: "follow up" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "old result" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "current result\naccount reminder" }],
      },
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "date reminder",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    ],
  };

  const rewritten = JSON.parse(
    rewriteInitialRequest(Buffer.from(JSON.stringify(current)), prefix, canonical, initialSystemMessages).toString("utf8"),
  ) as typeof current;
  assert.deepEqual(rewritten.messages[0]?.content, [...prefix, ...canonical]);
  assert.equal(
    ((rewritten.messages[1]?.content as Array<Record<string, unknown>>)[0]?.text as string),
    "environment reminder\ndate reminder",
  );
  assert.equal(
    ((rewritten.messages[1]?.content as Array<Record<string, unknown>>)[0]?.cache_control),
    undefined,
  );
  assert.equal(rewritten.messages.length, 8);
  assert.deepEqual(rewritten.messages[3]?.content, [{ type: "text", text: "follow up" }]);
  assert.equal(
    ((rewritten.messages[5]?.content as Array<Record<string, unknown>>)[0]?.content as string),
    "old result",
  );
  assert.deepEqual(
    (rewritten.messages[5]?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
  assert.equal(
    ((rewritten.messages[7]?.content as Array<Record<string, unknown>>)[0]?.content as string),
    "current result",
  );
  assert.deepEqual(
    (rewritten.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
});

test("runs a request through a stream-json Claude executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-test-"));
  const workingRoot = await realpath(root);
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
import {readFileSync} from "node:fs";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
if (process.argv.includes("auth") && process.argv.includes("login")) {
  console.log("Opening browser: https://claude.com/cai/oauth/authorize?state=test");
  if (process.env.AUTO_LOGIN === "1") {
    await new Promise(resolve => setTimeout(resolve, 25));
    process.exit(0);
  }
  const loginInput = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const code of loginInput) {
    if (code.trim() !== "test-code") process.exit(2);
    console.log("Login successful");
    process.exit(0);
  }
  process.exit(3);
}
if (process.cwd() !== process.env.EXPECTED_CWD) throw new Error(\`wrong cwd: \${process.cwd()}\`);
const systemIndex = process.argv.indexOf("--system-prompt-file");
if (systemIndex >= 0 && readFileSync(process.argv[systemIndex + 1], "utf8") !== process.env.EXPECTED_SYSTEM_PROMPT) {
  throw new Error("wrong system prompt");
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response: {
          models: [
            {value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default", description: "Opus with 1M context"},
            {value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Efficient", supportsAdaptiveThinking: true}
          ]
        }
      }
    }));
  }
  if (frame.shouldQuery === false) console.log(JSON.stringify({type: "result", num_turns: 0}));
}
const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
const events = [
  {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
  {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
  {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "ok"}},
  {type: "content_block_stop", index: 0},
  {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
  {type: "message_stop"}
];
for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content: [{type: "text", text: "ok"}], stop_reason: "end_turn", usage}}));
console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
`,
    "utf8",
  );
  await chmod(executable, 0o755);

  const events: string[] = [];
  try {
    const provider = createClaudeCodeProvider();
    const authCheck = await provider.auth.apiKey?.check?.({
      ctx: {
        env: async (name) => (name === "PI_CLAUDE_CODE_COMMAND" ? executable : undefined),
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    assert.equal(authCheck?.type, "oauth");
    assert.equal(provider.auth.oauth?.isSubscription, true);
    const authEvents: string[] = [];
    const credential = await provider.auth.oauth!.login({
      signal: new AbortController().signal,
      prompt: async (prompt) => {
        assert.equal(prompt.type, "manual_code");
        return "test-code";
      },
      notify: (event) => authEvents.push(event.type),
    });
    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, "claude-code-external");
    assert.ok(authEvents.includes("info"));

    let autoPromptDismissed = false;
    const autoStatus = await loginClaudeCode(
      {
        signal: new AbortController().signal,
        prompt: (prompt) =>
          new Promise<string>((_resolve, reject) => {
            prompt.signal?.addEventListener(
              "abort",
              () => {
                autoPromptDismissed = true;
                reject(new Error("dismissed"));
              },
              { once: true },
            );
          }),
        notify: () => {},
      },
      { PI_CLAUDE_CODE_COMMAND: executable, AUTO_LOGIN: "1" },
    );
    assert.equal(autoStatus.subscription, true);
    assert.equal(autoPromptDismissed, true);

    const discovered = await discoverClaudeModels(
      { PI_CLAUDE_CODE_COMMAND: executable, EXPECTED_CWD: process.cwd() },
      undefined,
      5_000,
    );
    assert.deepEqual(discovered.map((model) => model.value), ["default", "sonnet"]);

    const result = await runClaudeRequest({
      model: "sonnet",
      cwd: workingRoot,
      frames: [
        { type: "user", message: { role: "user", content: [{ type: "text", text: "old" }] }, shouldQuery: false },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "new" }] } },
      ],
      systemPrompt: "system",
      manifest: [],
      extraBody: { tools: [] },
      toolNames: new Set(),
      env: {
        PI_CLAUDE_CODE_COMMAND: executable,
        EXPECTED_CWD: workingRoot,
        EXPECTED_SYSTEM_PROMPT: "system",
      },
      timeoutMs: 5_000,
      onEvent: (event) => events.push(event.type),
    });
    assert.equal(result.message.id, "m_fake");
    assert.equal(result.message.stop_reason, "end_turn");
    assert.equal(result.usage.input_tokens, 3);
    assert.equal(result.admission.upstreamRequests, 0);
    assert.equal(events.at(-1), "message_stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
