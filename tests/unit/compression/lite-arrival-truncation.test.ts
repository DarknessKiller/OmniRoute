/**
 * Lite caps a tool result once, when it first arrives, never on a later turn: a provider
 * prompt cache only hits on identical bytes, so rewriting an already-sent message re-bills
 * the history as cache creation. The cap is idempotent and leaves the earlier messages a
 * prefix-cache match depends on byte-identical.
 * Run: node --import tsx/esm --test tests/unit/compression/lite-arrival-truncation.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyLiteCompression,
  compressToolResults,
} from "../../../open-sse/services/compression/lite.ts";
import { applyCompression } from "../../../open-sse/services/compression/strategySelector.ts";

const MAX = 300;
const FILE = Array.from({ length: 400 }, (_, i) => `${i + 1}: def metric_${i}(x): return x`).join(
  "\n"
);
const SINGLE_LINE = "word ".repeat(400).trim();
const MARKER = "\n...[truncated]";

type Msg = { role: string; content: unknown; [key: string]: unknown };

function readCall(id: string): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name: "read", arguments: '{"filePath":"/s.py"}' } },
    ],
  };
}

function toolMsg(id: string, content: string): Msg {
  return { role: "tool", tool_call_id: id, content };
}

describe("lite truncates tool results on arrival", () => {
  it("truncates the newest tool result to the cap", () => {
    const { body, applied } = compressToolResults(
      { messages: [{ role: "user", content: "read it" }, readCall("c1"), toolMsg("c1", FILE)] },
      { maxToolLength: MAX }
    );
    const newest = body.messages![2];
    assert.equal(applied, true);
    assert.ok(String(newest.content).endsWith(MARKER));
    assert.ok(String(newest.content).length <= MAX);
    assert.equal(newest.tool_call_id, "c1");
  });

  it("is idempotent and every capped result fits under the cap", () => {
    const body = {
      messages: [
        { role: "user", content: "read both" },
        readCall("c1"),
        toolMsg("c1", FILE),
        readCall("c2"),
        toolMsg("c2", SINGLE_LINE),
      ],
    };
    const opts = { maxToolLength: MAX, compressToolResults: true };
    const first = applyLiteCompression(body, opts);
    const second = applyLiteCompression(first.body, opts);

    assert.deepEqual(second.body.messages, first.body.messages);
    for (const msg of first.body.messages as Msg[]) {
      if (typeof msg.content === "string" && msg.content.endsWith(MARKER)) {
        assert.ok(msg.content.length <= MAX, `capped result is ${msg.content.length} chars`);
      }
    }
  });

  it("leaves the messages it already touched byte-identical when the next turn arrives", () => {
    const base = [
      { role: "user", content: "read it" },
      readCall("c1"),
      toolMsg("c1", FILE),
      readCall("c2"),
      toolMsg("c2", FILE),
    ];
    const opts = { maxToolLength: MAX, compressToolResults: true };
    const first = applyLiteCompression({ messages: base }, opts);
    const firstMessages = first.body.messages as Msg[];

    const touched = firstMessages
      .map((msg, i) => (msg.content === base[i].content ? -1 : i))
      .filter((i) => i >= 0);
    assert.deepEqual(touched, [2, 4]);

    const extended = [...firstMessages, { role: "user", content: "now the next turn" }];
    const second = applyLiteCompression({ messages: extended }, opts);
    const secondMessages = second.body.messages as Msg[];

    for (const i of touched) {
      assert.deepEqual(secondMessages[i], firstMessages[i], `message ${i} was rewritten`);
    }
  });

  it("truncates Anthropic tool_result blocks and keeps their tool_use_id", () => {
    const body = {
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: FILE }],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "Read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_2", content: FILE }],
        },
      ],
    };
    const { body: out } = compressToolResults(body, { maxToolLength: MAX });
    const messages = out.messages as Msg[];
    for (const index of [2, 4]) {
      const block = (messages[index].content as Array<Record<string, unknown>>)[0];
      assert.equal(block.type, "tool_result");
      assert.equal(block.tool_use_id, index === 2 ? "tu_1" : "tu_2");
      assert.ok(String(block.content).endsWith(MARKER));
      assert.ok(String(block.content).length <= MAX);
    }
  });

  it("truncates trailing OpenAI Responses tool outputs and keeps their call_id", () => {
    const result = applyCompression(
      {
        model: "gpt-5",
        input: [
          { role: "developer", content: "rules" },
          { role: "user", content: "read it" },
          { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: FILE },
        ],
      },
      "stacked",
      {
        config: {
          enabled: true,
          defaultMode: "off",
          autoTriggerTokens: 0,
          cacheMinutes: 5,
          preserveSystemPrompt: true,
          comboOverrides: {},
          engines: {},
          activeComboId: null,
          stackedPipeline: [{ engine: "lite", config: { maxToolLength: MAX } }],
        },
      }
    );
    const input = result.body.input as Array<Record<string, unknown>>;
    assert.equal(input[3].type, "function_call_output");
    assert.equal(input[3].call_id, "c1");
    assert.ok(String(input[3].output).endsWith(MARKER));
    assert.ok(String(input[3].output).length <= MAX);
  });
});
