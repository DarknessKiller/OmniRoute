/**
 * session-dedup elides a repeated block once, when it first arrives, never on a later turn:
 * a provider prompt cache only hits on identical bytes, so rewriting an already-sent message
 * re-bills the history as cache creation. The first copy always stays intact, and the marker
 * always points at a copy still present in the same request.
 * Run: node --import tsx/esm --test tests/unit/compression/session-dedup-arrival.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";
import {
  resetCcrStore,
  retrieveBlock,
} from "../../../open-sse/services/compression/engines/ccr/index.ts";
import crypto from "node:crypto";

const FILE = Array.from(
  { length: 12 },
  (_, i) => `${i + 1}\tfinal line${i} = cart.items[${i}];`
).join("\n");
const MARKER = /\[dedup:ref sha=[0-9a-f]{24}\]/;

type Msg = { role: string; content: unknown; [key: string]: unknown };

function readCall(id: string): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name: "Read", arguments: '{"path":"cart.dart"}' } },
    ],
  };
}

function apply(messages: Msg[]) {
  const result = sessionDedupEngine.apply({ model: "gpt-4", messages });
  return { result, messages: result.body.messages as Msg[] };
}

describe("session-dedup elides on arrival", () => {
  it("elides a repeated block in the newest message and keeps the first copy", () => {
    const { result, messages } = apply([
      { role: "user", content: `Here is the code:\n${FILE}` },
      { role: "assistant", content: "I understand." },
      { role: "user", content: `Please review again:\n${FILE}` },
    ]);
    assert.equal(result.compressed, true);
    assert.ok(String(messages[0].content).includes(FILE));
    assert.match(String(messages[2].content), MARKER);
    assert.ok(!String(messages[2].content).includes(FILE));
    // The marker names the block whose first copy is still intact in this request.
    const sha = String(messages[2].content).match(/sha=([0-9a-f]+)/)![1];
    assert.equal(sha, crypto.createHash("sha256").update(FILE).digest("hex").slice(0, 24));
  });

  it("elides a re-read tool result while it is still the newest message", () => {
    const { messages } = apply([
      { role: "user", content: "animate the cart" },
      readCall("c1"),
      { role: "tool", tool_call_id: "c1", content: FILE },
      readCall("c2"),
      { role: "tool", tool_call_id: "c2", content: FILE },
    ]);
    assert.ok(String(messages[2].content).includes(FILE));
    assert.match(String(messages[4].content), MARKER);
    assert.equal(messages[2].tool_call_id, "c1");
    assert.equal(messages[4].tool_call_id, "c2");
  });

  it("is idempotent over its own output", () => {
    const body = {
      model: "gpt-4",
      messages: [
        { role: "user", content: `first:\n${FILE}` },
        { role: "assistant", content: "ok" },
        { role: "user", content: `second:\n${FILE}` },
      ],
    };
    const first = sessionDedupEngine.apply(body);
    assert.equal(first.compressed, true);
    const second = sessionDedupEngine.apply(first.body);
    assert.deepEqual(second.body.messages, first.body.messages);
  });

  it("leaves the messages it already touched byte-identical when the next turn arrives", () => {
    const base: Msg[] = [
      { role: "user", content: `first:\n${FILE}` },
      { role: "assistant", content: "ok" },
      { role: "user", content: `second:\n${FILE}` },
    ];
    const first = apply(base);
    const touched = first.messages
      .map((msg, i) => (msg.content === base[i].content ? -1 : i))
      .filter((i) => i >= 0);
    assert.deepEqual(touched, [2]);

    const extended = [...first.messages, { role: "user", content: `third:\n${FILE}` }];
    const second = apply(extended);

    for (const i of touched) {
      assert.deepEqual(second.messages[i], first.messages[i], `message ${i} was rewritten`);
    }
    assert.match(String(second.messages[3].content), MARKER);
    assert.ok(String(second.messages[0].content).includes(FILE));
  });

  it("elides Anthropic tool_result blocks and keeps their tool_use_id", () => {
    const { messages } = apply([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: FILE }],
      },
      { role: "assistant", content: "noted" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_2", content: FILE }],
      },
    ]);
    const kept = (messages[0].content as Array<Record<string, unknown>>)[0];
    const elided = (messages[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(kept.tool_use_id, "tu_1");
    assert.equal(kept.content, FILE);
    assert.equal(elided.tool_use_id, "tu_2");
    assert.match(String(elided.content), MARKER);
  });

  it("elides a fuzzy near-duplicate in the newest turn, resolvable to a copy in the request", () => {
    resetCcrStore();
    const firstText =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    const newestText = firstText + " pi";
    const body = {
      messages: [
        { role: "user", content: firstText },
        { role: "assistant", content: "received" },
        { role: "user", content: newestText },
      ],
      tools: [{ type: "function", function: { name: "omniroute_ccr_retrieve" } }],
    };
    const result = sessionDedupEngine.apply(body, {
      stepConfig: { fuzzy: { enabled: true } },
      principalId: "p1",
    });
    const messages = result.body.messages as Msg[];
    assert.equal(result.compressed, true);
    assert.equal(messages[0].content, firstText);
    assert.match(String(messages[2].content), /^\[CCR retrieve hash=[0-9a-f]{24} chars=\d+\]$/);
    // The marker resolves to the elided copy; the first copy is still in the request verbatim.
    const hash = String(messages[2].content).match(/hash=([0-9a-f]{24})/)![1];
    assert.equal(retrieveBlock(hash, "p1"), newestText);
    assert.equal(messages[0].content, firstText);
  });
});
