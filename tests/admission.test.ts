import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { Admission } from "../src/admission.ts";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      resolve(address.port);
    });
  });
}

test("admits one upstream Messages request and captures its SSE response", async () => {
  const upstreamBodies: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamBodies.push(body);
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
    const usage = {
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const events = [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const upstreamPort = await listen(upstream);
  const observed: string[] = [];
  const admission = new Admission(
    `http://127.0.0.1:${upstreamPort}`,
    5_000,
    (event) => observed.push(event.type),
    (body) => Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), rewritten: true })),
  );

  try {
    const baseUrl = await admission.start();
    const first = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(second.status, 400);
    await admission.settled();

    assert.equal(upstreamBodies.length, 1);
    assert.deepEqual(JSON.parse(upstreamBodies[0]!), { rewritten: true });
    assert.equal(admission.used, true);
    assert.equal(admission.denied, 1);
    assert.equal(admission.capture.complete, true);
    assert.equal(admission.capture.message?.content[0]?.type, "text");
    assert.equal((admission.capture.message?.content[0] as { text: string }).text, "hello");
    assert.equal(admission.requestId, "req_test");
    assert.deepEqual(observed.at(-1), "message_stop");
  } finally {
    await admission.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
