import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageFreeze,
  resetMessageFreeze,
  getMessageFreezeStats,
  MAX_FROZEN_MESSAGES,
} from "../../../open-sse/services/compression/messageFreeze.ts";
import { applyCompression } from "../../../open-sse/services/compression/strategySelector.ts";
import {
  createCompressionStats,
  getDefaultCompressionConfig,
} from "../../../open-sse/services/compression/stats.ts";
import {
  registerCompressionEngine,
  setEngineEnabled,
  unregisterCompressionEngine,
} from "../../../open-sse/services/compression/engines/registry.ts";
import type { CompressionEngine } from "../../../open-sse/services/compression/engines/types.ts";
import type {
  CompressionConfig,
  CompressionPipelineStep,
  CompressionResult,
} from "../../../open-sse/services/compression/types.ts";

/**
 * Cache-stable compression: an engine rewrites a message when it first arrives and emits the
 * same bytes for it on every later turn (providers key the prompt cache on an exact byte prefix).
 */
const ENGINE_ID = "test-nondeterministic-freeze";
let callCount = 0;

const rewritingEngine: CompressionEngine = {
  id: ENGINE_ID,
  name: "Test Non-deterministic",
  description: "test-only engine that emits different bytes per call",
  icon: "bug_report",
  targets: ["messages"],
  stackable: true,
  stackPriority: 0,
  apply(body): CompressionResult {
    callCount++;
    const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
    const rewritten = messages.map((message) => ({
      ...message,
      // Shrinks (so the aggregate inflation guard keeps it) yet differs per call (non-stable).
      content: `${String(message.content).slice(0, 2)}~${callCount}`,
    }));
    const nextBody = { ...body, messages: rewritten };
    return {
      body: nextBody,
      compressed: true,
      stats: createCompressionStats(body, nextBody, "stacked", [ENGINE_ID]),
    };
  },
  compress(body) {
    return this.apply(body);
  },
  getConfigSchema() {
    return [];
  },
  validateConfig() {
    return { valid: true, errors: [] };
  },
};

function config(): CompressionConfig {
  return {
    ...getDefaultCompressionConfig(),
    enabled: true,
    stackedPipeline: [{ engine: ENGINE_ID } as CompressionPipelineStep],
  };
}

function run(
  messages: Array<Record<string, unknown>>,
  options: { principalId?: string } = {}
): CompressionResult {
  return applyCompression({ model: "test-model", messages }, "stacked", {
    config: config(),
    principalId: options.principalId,
  });
}

function contents(result: CompressionResult): string[] {
  const messages = (result.body as { messages: Array<Record<string, unknown>> }).messages;
  return messages.map((message) => String(message.content));
}

describe("messageFreeze — cache-stable compression", () => {
  beforeEach(() => {
    resetMessageFreeze();
    callCount = 0;
    registerCompressionEngine(rewritingEngine);
    setEngineEnabled(ENGINE_ID, true);
  });
  afterEach(() => {
    unregisterCompressionEngine(ENGINE_ID);
    resetMessageFreeze();
  });

  it("replays the first bytes of an already-sent message on later turns", () => {
    const turn1 = run([{ role: "user", content: "hello" }]);
    const turn2 = run([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "next question" },
    ]);

    const [first] = contents(turn2);
    assert.equal(first, contents(turn1)[0], "turn-1 message must keep its turn-1 bytes");
    assert.equal(first, "he~1", "the engine's call-2 rewrite must be replayed away");
    // New messages are compressed normally on the turn they arrive.
    assert.equal(contents(turn2)[2], "ne~2");
  });

  it("stays byte-identical across many turns (prefix-cache anchor)", () => {
    const first = contents(run([{ role: "user", content: "anchor" }]))[0];
    let history: Array<Record<string, unknown>> = [{ role: "user", content: "anchor" }];
    for (let turn = 0; turn < 5; turn++) {
      history = [
        ...history,
        { role: "assistant", content: `answer ${turn}` },
        { role: "user", content: `question ${turn}` },
      ];
      assert.equal(contents(run(history))[0], first);
    }
  });
  it("keeps replaying when a later engine run declines to compress the message", () => {
    // Turn 1: the engine rewrites and the bytes are frozen.
    const first = contents(run([{ role: "user", content: "stable" }]))[0];
    // Turn 2: the engine returns the body untouched (compressed: false). The frozen bytes must
    // still win, otherwise the upstream prefix would revert to the raw message.
    const lazy: CompressionEngine = {
      ...rewritingEngine,
      apply(body): CompressionResult {
        return {
          body,
          compressed: false,
          stats: createCompressionStats(body, body, "stacked", [ENGINE_ID]),
        };
      },
    };
    registerCompressionEngine(lazy);
    const turn2 = run([
      { role: "user", content: "stable" },
      { role: "user", content: "new turn" },
    ]);
    assert.equal(contents(turn2)[0], first);
    assert.equal(turn2.compressed, true, "a replayed body must still be sent upstream");
  });

  it("does not replay across principals", () => {
    run([{ role: "user", content: "shared text" }], { principalId: "tenant-a" });
    const otherTenant = run([{ role: "user", content: "shared text" }], {
      principalId: "tenant-b",
    });
    assert.match(contents(otherTenant)[0], /~2/);
  });

  it("fails open when the engine drops or reorders messages", () => {
    const engine: CompressionEngine = {
      ...rewritingEngine,
      apply(body): CompressionResult {
        const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
        const nextBody = { ...body, messages: messages.slice(1) };
        return {
          body: nextBody,
          compressed: true,
          stats: createCompressionStats(body, nextBody, "stacked", [ENGINE_ID]),
        };
      },
    };
    registerCompressionEngine(engine);
    const result = run([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);
    const messages = (result.body as { messages: Array<Record<string, unknown>> }).messages;
    assert.equal(messages.length, 1, "unaligned output must pass through untouched");
    assert.equal(getMessageFreezeStats().stored, 0, "unaligned output must not be stored");
  });

  it("does not store when nothing was compressed", () => {
    const untouched = applyMessageFreeze(
      { messages: [{ role: "user", content: "x" }] },
      { body: { messages: [{ role: "user", content: "y" }] }, compressed: false, stats: null },
      { mode: "stacked" }
    );
    assert.equal(
      (untouched.body as { messages: Array<{ content: string }> }).messages[0].content,
      "y"
    );
    assert.equal(getMessageFreezeStats().size, 0);
  });

  it("caps the store (oldest entries evicted first)", () => {
    const messages = Array.from({ length: MAX_FROZEN_MESSAGES + 5 }, (_, i) => ({
      role: "user",
      content: `m${i}`,
    }));
    applyMessageFreeze(
      { messages },
      {
        body: { messages },
        compressed: true,
        stats: createCompressionStats({}, {}, "stacked", []),
      },
      { mode: "stacked" }
    );
    assert.equal(getMessageFreezeStats().size, MAX_FROZEN_MESSAGES);
  });

  it("does not replay across a transport change", () => {
    const direct = applyCompression(
      { model: "test-model", messages: [{ role: "user", content: "hello" }] },
      "stacked",
      { config: config(), providerTransport: "direct", imageTransportFidelity: "byte-preserving" }
    );
    // A transport-sensitive engine is a no-op off its transport; it must not inherit bytes
    // frozen for the other one (the raw message has to reach the aggregator).
    const aggregated = applyCompression(
      { model: "test-model", messages: [{ role: "user", content: "hello" }] },
      "stacked",
      { config: config(), providerTransport: "aggregator" }
    );
    assert.notEqual(contents(aggregated)[0], contents(direct)[0]);
  });

  it("keeps replaying when the resolved plan escalates between turns", () => {
    const operatorConfig = config();
    const freezeScope = { mode: "auto", config: operatorConfig };
    const turn1 = applyCompression(
      { model: "test-model", messages: [{ role: "user", content: "hello" }] },
      "stacked",
      { config: operatorConfig, freezeScope }
    );
    // The auto-trigger / adaptive ladder re-derives the plan from the history size on every
    // turn, and chatCore writes that plan back into the config it hands to the pipeline
    // (`config.stackedPipeline` + the resolved mode). A plan change must never re-decide an
    // already-sent message: the provider would re-bill the whole cached prefix as cache
    // creation instead of reading it.
    const escalated: CompressionConfig = {
      ...operatorConfig,
      defaultMode: "stacked",
      autoTriggerMode: "stacked",
      autoTriggerTokens: 1_000,
      enginesExplicit: true,
      engines: { [ENGINE_ID]: { enabled: true } } as CompressionConfig["engines"],
      stackedPipeline: [
        { engine: ENGINE_ID } as CompressionPipelineStep,
        { engine: ENGINE_ID } as CompressionPipelineStep,
      ],
    };
    const turn2 = applyCompression(
      {
        model: "test-model",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
      },
      "stacked",
      { config: escalated, freezeScope }
    );
    assert.equal(contents(turn2)[0], contents(turn1)[0]);
  });
});
