import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyLiveZoneCompression,
  getLiveZoneCacheStats,
  resetLiveZoneCache,
} from "../../../open-sse/services/compression/liveZone.ts";
import type { CompressionResult } from "../../../open-sse/services/compression/types.ts";

const options = {
  principalId: "key-1",
  sessionId: "shared-session",
  variant: { mode: "rtk", config: {} },
};

function recorder(calls: Array<Record<string, unknown>>) {
  return async (body: Record<string, unknown>): Promise<CompressionResult> => {
    calls.push(structuredClone(body));
    return {
      body: {
        ...body,
        messages: (body.messages as Array<Record<string, unknown>>).map((item) =>
          item.role === "tool" ? { ...item, content: `compressed:${String(item.content)}` } : item
        ),
      },
      compressed: true,
      stats: null,
    };
  };
}

beforeEach(() => resetLiveZoneCache());

describe("live-zone: branches sharing one session", () => {
  it("freezes each branch separately and reuses the longest matching prefix", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const compress = recorder(calls);
    const root = { role: "user", content: "shared root" };

    await applyLiveZoneCompression({ messages: [root] }, options, compress);

    // Claude Code subagents inherit the parent's session id, so both branches share the key.
    const branch = {
      messages: [
        root,
        { role: "assistant", content: "subagent" },
        { role: "tool", tool_call_id: "s1", content: "subagent output" },
      ],
    };
    await applyLiveZoneCompression(branch, options, compress);
    await applyLiveZoneCompression(
      {
        messages: [
          root,
          { role: "assistant", content: "parent" },
          { role: "tool", tool_call_id: "p1", content: "parent output" },
        ],
      },
      options,
      compress
    );

    calls.length = 0;
    const branchAgain = {
      messages: [
        ...branch.messages,
        { role: "assistant", content: "more" },
        { role: "tool", tool_call_id: "s2", content: "second output" },
      ],
    };
    const result = await applyLiveZoneCompression(branchAgain, options, compress);
    const payload = JSON.stringify(calls[0]?.messages ?? []);

    assert.equal(result.stats?.liveZone?.cacheHit, true);
    assert.equal(result.stats?.liveZone?.frozenItems, 3, "the longest stored prefix wins");
    assert.ok(!payload.includes("shared root"), "the frozen prefix must never be recompressed");
  });

  it("keeps every branch of a session, not a fixed number", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const compress = recorder(calls);
    const root = { role: "user", content: "shared root" };
    const body = (n: number) => ({ messages: [root, { role: "user", content: `branch-${n}` }] });

    for (let n = 1; n <= 12; n++) await applyLiveZoneCompression(body(n), options, compress);
    assert.equal(getLiveZoneCacheStats().entries, 12, "subagents must not evict each other");

    const beforeReplay = calls.length;
    for (let n = 1; n <= 12; n++) await applyLiveZoneCompression(body(n), options, compress);
    assert.equal(calls.length, beforeReplay, "every branch still hits its own frozen prefix");
  });

  it("reuses the shared prefix when a branch forks off an earlier turn", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const compress = recorder(calls);
    const root = { role: "user", content: "shared root" };
    const firstTool = { role: "tool", tool_call_id: "c1", content: "first output" };
    const followUp = { role: "user", content: "follow up" };

    for (const messages of [
      [root],
      [root, firstTool],
      [root, firstTool, followUp],
      [root, firstTool, followUp, { role: "tool", tool_call_id: "c2", content: "second output" }],
    ]) {
      await applyLiveZoneCompression({ messages }, options, compress);
    }

    calls.length = 0;
    const branch = {
      messages: [
        root,
        firstTool,
        followUp,
        { role: "tool", tool_call_id: "c2", content: "branch output" },
      ],
    };
    const result = await applyLiveZoneCompression(branch, options, compress);

    assert.equal(
      result.stats?.liveZone?.cacheHit,
      true,
      "a branch must not cold-rewrite the history"
    );
    assert.equal(result.stats?.liveZone?.frozenItems, 3, "reuse the turn the branch forks from");
    assert.deepEqual((result.body.messages as unknown[]).slice(0, 3), [
      root,
      { ...firstTool, content: "compressed:first output" },
      followUp,
    ]);
    assert.deepEqual(calls[0]?.messages, [branch.messages[3]]);
  });

  it("keeps the frozen prefix when only the per-request mode changes", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const compress = recorder(calls);
    const stored = {
      messages: [{ role: "tool", tool_call_id: "t1", content: "first output" }],
    };
    const first = await applyLiveZoneCompression(stored, options, compress);

    calls.length = 0;
    const next = {
      messages: [
        ...stored.messages,
        { role: "assistant", content: "more" },
        { role: "tool", tool_call_id: "t2", content: "second output" },
      ],
    };
    const autoTriggered = await applyLiveZoneCompression(
      next,
      { ...options, variant: { ...(options.variant as object), mode: "caveman" } },
      compress
    );
    assert.equal(autoTriggered.stats?.liveZone?.cacheHit, true);
    assert.deepEqual((autoTriggered.body.messages as unknown[]).slice(0, 1), first.body.messages);
    assert.ok(!JSON.stringify(calls[0]?.messages ?? []).includes("first output"));

    calls.length = 0;
    const upgraded = await applyLiveZoneCompression(
      next,
      {
        ...options,
        variant: { ...(options.variant as object), config: { defaultMode: "caveman" } },
      },
      compress
    );
    assert.equal(upgraded.stats?.liveZone, undefined, "a settings change re-plans the history");
    assert.equal((calls[0]?.messages as unknown[]).length, 3);
  });

  it("freezes the shared prefix when no stored turn ends at the fork point", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const compress = recorder(calls);
    const root = { role: "user", content: "shared root" };
    const firstTool = { role: "tool", tool_call_id: "c1", content: "first output" };
    // Parent turns are 1 and 4 items long: nothing ends at the fork's shared length of 2.
    await applyLiveZoneCompression({ messages: [root] }, options, compress);
    await applyLiveZoneCompression(
      {
        messages: [
          root,
          firstTool,
          { role: "assistant", content: "next" },
          { role: "tool", tool_call_id: "c2", content: "second output" },
        ],
      },
      options,
      compress
    );

    calls.length = 0;
    const branchTool = { role: "tool", tool_call_id: "c3", content: "branch output" };
    const branch = {
      messages: [root, firstTool, { role: "assistant", content: "fork" }, branchTool],
    };
    const result = await applyLiveZoneCompression(branch, options, compress);

    assert.equal(result.stats?.liveZone?.cacheHit, true);
    assert.equal(result.stats?.liveZone?.frozenItems, 2, "freeze the whole shared prefix");
    assert.deepEqual((result.body.messages as unknown[]).slice(0, 2), [
      root,
      { ...firstTool, content: "compressed:first output" },
    ]);
    assert.deepEqual(calls[0]?.messages, [branch.messages[2], branchTool]);
  });
});
