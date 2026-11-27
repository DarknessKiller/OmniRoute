/**
 * Claude Code sends tool output as `tool_result` blocks inside `role:"user"`
 * messages, not as OpenAI `role:"tool"` messages. The safe default pipeline
 * (session-dedup + lite) used to be blind to that shape, so Claude Code
 * requests produced zero savings and only `no_savings` skip rows.
 *
 * Run: node --import tsx/esm --test tests/unit/compression/anthropic-tool-results.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyLiteCompression,
  compressToolResults,
} from "../../../open-sse/services/compression/lite.ts";
import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";
import { applyCompression } from "../../../open-sse/services/compression/strategySelector.ts";

const FILE = Array.from({ length: 400 }, (_, i) => `${i + 1}: def metric_${i}(x): return x`).join(
  "\n"
);
const TRUNCATED = /\.\.\.\[truncated\]$/;

function toolUse(id: string) {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read", input: { filePath: "/s.py" } }],
  };
}

function toolResult(id: string, content: unknown) {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
  };
}

function resultBlocks(message: { content: unknown }): Array<Record<string, unknown>> {
  return message.content as Array<Record<string, unknown>>;
}

const SAFE_PIPELINE_CONFIG = {
  config: {
    enabled: true,
    defaultMode: "off",
    autoTriggerTokens: 0,
    cacheMinutes: 5,
    preserveSystemPrompt: true,
    comboOverrides: {},
    engines: {},
    activeComboId: null,
    stackedPipeline: [{ engine: "session-dedup" }, { engine: "lite" }],
  },
};

describe("lite: Anthropic tool_result blocks", () => {
  it("truncates tool_result string content on arrival, the newest included", () => {
    const { body, applied } = compressToolResults({
      messages: [
        { role: "user", content: "read it" },
        toolUse("t1"),
        toolResult("t1", FILE),
        toolUse("t2"),
        toolResult("t2", FILE),
      ],
    });

    assert.equal(applied, true);
    assert.match(String(resultBlocks(body.messages![2])[0].content), TRUNCATED);
    assert.match(String(resultBlocks(body.messages![4])[0].content), TRUNCATED);
  });

  it("truncates text blocks inside tool_result array content and keeps images", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const inner = [{ type: "text", text: FILE }, image];

    const { body, applied } = compressToolResults({
      messages: [
        { role: "user", content: "read it" },
        toolUse("t1"),
        toolResult("t1", inner),
        toolUse("t2"),
        toolResult("t2", inner),
      ],
    });

    assert.equal(applied, true);
    for (const index of [2, 4]) {
      const blocks = resultBlocks(body.messages![index])[0].content as Array<
        Record<string, unknown>
      >;
      assert.match(String(blocks[0].text), TRUNCATED);
      assert.deepEqual(blocks[1], image);
    }
  });

  it("reports compression through applyLiteCompression", () => {
    const result = applyLiteCompression({
      messages: [
        { role: "user", content: "read it" },
        toolUse("t1"),
        toolResult("t1", FILE),
        toolUse("t2"),
        toolResult("t2", FILE),
      ],
    });

    assert.equal(result.compressed, true);
    assert.ok(result.stats);
    assert.ok(result.stats.compressedTokens < result.stats.originalTokens);
  });
});

describe("session-dedup: Anthropic tool_result blocks", () => {
  it("deduplicates repeated tool_result text on arrival", () => {
    const result = sessionDedupEngine.apply({
      messages: [
        { role: "user", content: "read it" },
        toolUse("t1"),
        toolResult("t1", FILE),
        toolUse("t2"),
        toolResult("t2", FILE),
        toolUse("t3"),
        toolResult("t3", FILE),
      ],
    });

    assert.equal(result.compressed, true);
    const messages = result.body.messages as Array<{ content: unknown }>;

    // First occurrence stays intact; the later duplicates become references.
    assert.equal(resultBlocks(messages[2])[0].content, FILE);
    assert.match(String(resultBlocks(messages[4])[0].content), /^\[dedup:ref sha=[0-9a-f]+\]$/);
    assert.match(String(resultBlocks(messages[6])[0].content), /^\[dedup:ref sha=[0-9a-f]+\]$/);
  });
});

describe("safe pipeline: Claude Code request shape", () => {
  it("compresses tool results on arrival, the newest included", () => {
    const result = applyCompression(
      {
        messages: [
          { role: "user", content: "read it" },
          toolUse("t1"),
          toolResult("t1", FILE),
          toolUse("t2"),
          toolResult("t2", FILE),
        ],
      },
      "stacked",
      SAFE_PIPELINE_CONFIG
    );

    assert.equal(result.compressed, true);
    assert.ok(result.stats);
    assert.ok(result.stats.compressedTokens < result.stats.originalTokens);

    const messages = result.body.messages as Array<{ content: unknown }>;
    // The first copy is capped by lite; the duplicate is elided by session-dedup.
    assert.match(String(resultBlocks(messages[2])[0].content), TRUNCATED);
    assert.match(String(resultBlocks(messages[4])[0].content), /^\[dedup:ref sha=[0-9a-f]+\]$/);
  });
});
