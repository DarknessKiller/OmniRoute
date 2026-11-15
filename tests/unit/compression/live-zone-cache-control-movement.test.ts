import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyLiveZoneCompression,
  resetLiveZoneCache,
} from "../../../open-sse/services/compression/liveZone.ts";
import type { CompressionResult } from "../../../open-sse/services/compression/types.ts";

function result(body: Record<string, unknown>): CompressionResult {
  return {
    body,
    compressed: true,
    stats: {
      originalTokens: 100,
      compressedTokens: 50,
      savingsPercent: 50,
      techniquesUsed: ["test"],
      mode: "rtk",
      timestamp: Date.now(),
    },
  };
}

const options = {
  principalId: "key-1",
  sessionId: "session-cache-control",
  variant: { mode: "rtk", config: {} },
};

beforeEach(() => resetLiveZoneCache());

describe("live zone and a moving Anthropic cache_control breakpoint", () => {
  // An Anthropic client puts `cache_control` on the newest message every turn, so the
  // marker moves onto items that were already sent. That must not be mistaken for a
  // text change: the whole point of the zone is that the prefix stays byte-stable.
  it("keeps the frozen prefix when cache_control moves onto a previously live item", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const compress = async (body: Record<string, unknown>): Promise<CompressionResult> => {
      calls.push(structuredClone(body));
      const items = body.messages as Array<Record<string, unknown>>;
      return result({
        ...body,
        messages: items.map((item) =>
          item.role === "tool" ? { ...item, content: `compressed:${String(item.content)}` } : item
        ),
      });
    };

    const first = {
      messages: [
        { role: "system", content: "stable" },
        { role: "user", content: "run tests" },
        { role: "assistant", content: "running" },
        { role: "tool", tool_call_id: "c1", content: "100 noisy lines" },
      ],
    };
    const firstResult = await applyLiveZoneCompression(first, options, compress);
    const frozenBytes = JSON.stringify((firstResult.body.messages as unknown[]).slice(0, 4));

    // Next turn: the caller moves its breakpoint onto the previously sent tool result.
    const second = {
      messages: [
        first.messages[0],
        first.messages[1],
        first.messages[2],
        { ...first.messages[3], cache_control: { type: "ephemeral" } },
        { role: "assistant", content: "next step" },
        { role: "tool", tool_call_id: "c2", content: "new observation" },
      ],
    };
    const secondResult = await applyLiveZoneCompression(second, options, compress);

    assert.equal(calls.length, 2);
    assert.equal(
      JSON.stringify((secondResult.body.messages as unknown[]).slice(0, 4)),
      frozenBytes,
      "a moved cache_control must not invalidate the frozen prefix"
    );
    assert.equal(secondResult.stats?.liveZone?.cacheHit, true);
    // The frozen prefix is the cached transformation, so only the text comparisons above
    // matter; the moved marker lives on the live copy, which the client re-sends anyway.
  });
});
