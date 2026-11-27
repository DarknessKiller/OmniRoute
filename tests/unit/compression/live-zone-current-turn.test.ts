import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { adaptBodyForCompression } from "../../../open-sse/services/compression/bodyAdapter.ts";
import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";
import {
  applyLiveZoneCompression,
  resetLiveZoneCache,
} from "../../../open-sse/services/compression/liveZone.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import {
  applyCompression,
  applyCompressionAsync,
} from "../../../open-sse/services/compression/strategySelector.ts";
import {
  DEFAULT_COMPRESSION_CONFIG,
  type CompressionResult,
} from "../../../open-sse/services/compression/types.ts";

// Synthetic observations: no private requests, tool names, or provider calls.
const observation = Array.from(
  { length: 180 },
  (_, i) => `observation ${i}: preserve this fact`
).join("\n");
const options = {
  principalId: "synthetic-principal",
  sessionId: "synthetic-session",
  variant: { mode: "stacked", config: {} },
};
const config = {
  ...DEFAULT_COMPRESSION_CONFIG,
  enabled: true,
  stackedPipeline: [{ engine: "session-dedup" as const }, { engine: "lite" as const }],
};
type Item = Record<string, unknown>;
const assistant = (...ids: string[]): Item => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({
    id,
    type: "function",
    function: { name: "inspect", arguments: "{}" },
  })),
});
const tool = (id: string): Item => ({ role: "tool", tool_call_id: id, content: observation });
const compress = async (body: Record<string, unknown>) =>
  applyCompression(body, "stacked", { config });
const messagesOf = (result: CompressionResult) => result.body.messages as Item[];

beforeEach(() => resetLiveZoneCache());
after(() => resetDbInstance());

// These shapes are selected by live-zone isToolOutputItem. Native roleless Responses
// turn-boundary detection and the session-dedup single-text-slot path are separate issues.
const outputShapes = [
  {
    field: "messages",
    item: { role: "tool", tool_call_id: "one", name: "inspect", content: observation },
    link: "tool_call_id",
  },
  {
    field: "messages",
    item: { role: "function", name: "inspect", content: observation },
    link: "name",
  },
  {
    field: "messages",
    item: { role: "tool_result", tool_use_id: "one", content: observation },
    link: "tool_use_id",
  },
  ...[
    "function_call_output",
    "local_shell_call_output",
    "apply_patch_call_output",
    "computer_call_output",
    "tool_result",
  ].map((type) => ({
    field: "input",
    item: { type, call_id: "one", name: "inspect", output: observation },
    link: "call_id",
  })),
];

// LZ-R1-01: count equality is not evidence of source-to-result correspondence.
describe("live-zone contextual copy-back correspondence", () => {
  it("retains the current tool when real Lite removal and CCR insertion cancel in cardinality", async () => {
    const pipelineConfig = {
      ...DEFAULT_COMPRESSION_CONFIG,
      enabled: true,
      stackedPipeline: [
        { engine: "lite" as const },
        { engine: "ccr" as const, config: { minChars: 300 } },
      ],
    };
    const run = async (body: Record<string, unknown>) =>
      applyCompressionAsync(body, "stacked", {
        config: pipelineConfig,
        principalId: options.principalId,
      });
    const pipelineOptions = { ...options, variant: { mode: "stacked", config: pipelineConfig } };
    const tools = ["inspect", "omniroute_ccr_retrieve"].map((name) => ({
      type: "function",
      function: { name, parameters: { type: "object", properties: {} } },
    }));
    const prefix = [
      { role: "user", content: "Inspect synthetic facts" },
      { role: "assistant", content: "Ready for inspection" },
    ];
    const first = await applyLiveZoneCompression({ tools, messages: prefix }, pipelineOptions, run);
    const current = {
      role: "tool",
      tool_call_id: "current",
      content: "CURRENT RESULT MUST REMAIN A TOOL",
    };
    const body = {
      tools,
      messages: [
        ...prefix,
        { role: "user", content: observation },
        assistant("current"),
        current,
        { role: "user", content: "duplicate after current tool" },
        { role: "user", content: "duplicate after current tool" },
      ],
    };
    const original = structuredClone(body);
    const contextual = body.messages.slice(1);
    const direct = await run({ tools, messages: contextual });
    assert.equal(messagesOf(direct).length, contextual.length, "net cardinality is unchanged");
    assert.deepEqual(
      contextual.map((item) => item.role),
      ["assistant", "user", "assistant", "tool", "user", "user"]
    );
    assert.deepEqual(
      messagesOf(direct).map((item) => item.role),
      ["system", "assistant", "user", "assistant", "tool", "user"]
    );
    const warm = await applyLiveZoneCompression(body, pipelineOptions, run);
    assert.deepEqual(messagesOf(warm)[4], current, "role, tool_call_id and content must survive");
    assert.deepEqual(messagesOf(warm).slice(0, prefix.length), first.body.messages);
    assert.deepEqual(messagesOf(warm).slice(prefix.length), body.messages.slice(prefix.length));
    assert.deepEqual(body, original, "the request must not be mutated");
    assert.equal(warm.stats?.liveZone?.cacheHit, true);
  });

  for (const { field, item: shape, link } of outputShapes) {
    const label = String("role" in shape ? shape.role : shape.type);
    const firstOutput: Item = shape;
    const secondOutput: Item = { ...firstOutput, [link]: "two" };
    const live = [assistant("one", "two"), firstOutput, secondOutput, assistant("done")];
    const mutations: Array<[string, (items: unknown[]) => void]> = [
      [
        "wrong linkage",
        (items) => {
          (items[2] as Item)[link] = "wrong";
        },
      ],
      [
        "missing linkage",
        (items) => {
          delete (items[2] as Item)[link];
        },
      ],
      [
        "same-role output swap",
        (items) => {
          [items[2], items[3]] = [items[3], items[2]];
        },
      ],
      [
        "changed role",
        (items) => {
          (items[2] as Item).role = "assistant";
        },
      ],
      [
        "changed type",
        (items) => {
          (items[2] as Item).type = "message";
        },
      ],
      [
        "changed name",
        (items) => {
          (items[2] as Item).name = "other-tool";
        },
      ],
      [
        "changed assistant linkage",
        (items) => {
          (items[1] as Item).tool_calls = [];
        },
      ],
      [
        "sparse slot",
        (items) => {
          delete items[2];
        },
      ],
      [
        "null slot",
        (items) => {
          items[2] = null;
        },
      ],
      [
        "nonobject slot",
        (items) => {
          items[2] = "not an item";
        },
      ],
      [
        "array slot",
        (items) => {
          items[2] = [];
        },
      ],
    ];
    for (const [mutation, mutate] of mutations) {
      it(`keeps original ${field}/${label} items for ${mutation}, including in-place callback mutations`, async () => {
        let calls = 0;
        const run = async (body: Record<string, unknown>): Promise<CompressionResult> => {
          const items = body[field] as unknown[];
          if (++calls === 1) {
            return {
              body: {
                ...body,
                [field]: items.map((item) => ({ ...(item as Item), content: "frozen" })),
              },
              compressed: true,
              stats: null,
            };
          }
          for (const item of items as Item[]) {
            if ("output" in item) item.output = "compressed";
            else item.content = "compressed";
          }
          mutate(items);
          return { body, compressed: true, stats: null };
        };
        const prefix = [
          { role: "user", content: "Inspect" },
          { role: "assistant", content: "Ready" },
        ];
        const first = await applyLiveZoneCompression({ [field]: prefix }, options, run);
        const body = { [field]: [...prefix, ...live] };
        const original = structuredClone(body);
        const next = await applyLiveZoneCompression(body, options, run);
        assert.deepEqual(next.body[field], [...(first.body[field] as Item[]), ...live]);
        assert.deepEqual(body, original);
        assert.equal(next.stats?.liveZone?.cacheHit, true);
      });
    }

    it(`allows content/output-only compression of linked completed ${field}/${label} history`, async () => {
      let calls = 0;
      const run = async (body: Record<string, unknown>): Promise<CompressionResult> => {
        if (++calls > 1) {
          const items = body[field] as Item[];
          for (const index of [2, 3]) {
            const key = "output" in items[index] ? "output" : "content";
            items[index][key] = "compressed";
          }
        }
        return { body, compressed: true, stats: null };
      };
      const prefix = [
        { role: "user", content: "Inspect" },
        { role: "assistant", content: "Ready" },
      ];
      const first = await applyLiveZoneCompression({ [field]: prefix }, options, run);
      const body = { [field]: [...prefix, ...live] };
      const original = structuredClone(body);
      const next = await applyLiveZoneCompression(body, options, run);
      const key = "output" in firstOutput ? "output" : "content";
      assert.deepEqual(next.body[field], [
        ...(first.body[field] as Item[]),
        live[0],
        { ...firstOutput, [key]: "compressed" },
        { ...secondOutput, [key]: "compressed" },
        live[3],
      ]);
      assert.deepEqual(body, original);
    });
  }

  for (const linkage of [undefined, "reused-call"]) {
    it(`preserves ambiguous same-role outputs with ${linkage ? "duplicate" : "missing"} call identity`, async () => {
      let calls = 0;
      const run = async (body: Record<string, unknown>): Promise<CompressionResult> => {
        if (++calls > 1) {
          const items = body.messages as Item[];
          [items[2], items[3]] = [items[3], items[2]];
        }
        return { body, compressed: true, stats: null };
      };
      const prefix = [{ role: "user", content: "Inspect" }, assistant("one", "two")];
      const first = await applyLiveZoneCompression({ messages: prefix }, options, run);
      const outputs = ["first result", "second result"].map((content) => ({
        role: "tool",
        ...(linkage ? { tool_call_id: linkage } : {}),
        content,
      }));
      const body = {
        messages: [...prefix, assistant("one", "two"), ...outputs, assistant("done")],
      };
      const original = structuredClone(body);
      const next = await applyLiveZoneCompression(body, options, run);
      assert.deepEqual(messagesOf(next), [
        ...messagesOf(first),
        ...original.messages.slice(prefix.length),
      ]);
      assert.deepEqual(body, original);
    });
  }
});

describe("live-zone composition over arrival-scoped engines", () => {
  for (const mode of ["lite", "stacked"] as const) {
    for (const boundaryInCache of [false, true]) {
      it(`${mode} caps parallel observations on arrival with a byte-stable prefix (assistant boundary ${boundaryInCache ? "frozen" : "live"})`, async () => {
        const run = async (body: Record<string, unknown>) =>
          applyCompression(body, mode, { config });
        const prefix: Item[] = [{ role: "user", content: "Inspect both observations" }];
        if (boundaryInCache) prefix.push(assistant("first", "parallel"));
        const first = await applyLiveZoneCompression({ messages: prefix }, options, run);
        const messages = [
          ...prefix,
          ...(boundaryInCache ? [] : [assistant("first", "parallel")]),
          tool("first"),
          tool("parallel"),
        ];
        const original = structuredClone(messages);
        const direct = await applyLiveZoneCompression(
          { messages },
          { ...options, sessionId: "cold-control" },
          run
        );
        const warm = await applyLiveZoneCompression({ messages }, options, run);
        // Both observations are capped/elided when they arrive, never on a later turn.
        assert.notDeepEqual(messagesOf(direct).slice(-2), messages.slice(-2), "cold control");
        assert.notDeepEqual(messagesOf(warm).slice(-2), messages.slice(-2));
        assert.deepEqual(messagesOf(warm).slice(0, prefix.length), messagesOf(first));
        assert.deepEqual(messages, original, "request input must not be mutated");
        assert.equal(warm.stats?.liveZone?.cacheHit, true);
      });
    }
  }

  it("compresses completed history and current observations on arrival, keeping instructions", async () => {
    const prefix = [{ role: "user", content: "Inspect the history" }];
    const first = await applyLiveZoneCompression({ messages: prefix }, options, compress);
    const live = [
      assistant("old-1"),
      tool("old-1"),
      assistant("old-2"),
      tool("old-2"),
      { role: "system", content: "Keep the instruction boundary exactly" },
      { role: "developer", content: "Do not change the task" },
      assistant("current", "parallel"),
      tool("current"),
      tool("parallel"),
      { role: "user", content: "Continue with these observations" },
    ];
    const body = { messages: [...prefix, ...live] };
    const original = structuredClone(body);
    const warm = await applyLiveZoneCompression(body, options, compress);
    const items = messagesOf(warm);
    assert.ok(String(items[2].content).endsWith("...[truncated]"), "completed output is capped");
    assert.match(String(items[4].content), /\[dedup:ref sha=/, "completed duplicate is deduped");
    for (const i of [1, 3, 7, 8]) {
      const toolContent = items[prefix.length + i].content;
      assert.notEqual(toolContent, observation, `live item ${i} must be compressed on arrival`);
    }
    for (const i of [4, 5, 9]) {
      assert.deepEqual(items[prefix.length + i], live[i]);
    }
    assert.deepEqual(items.slice(0, prefix.length), messagesOf(first));
    assert.deepEqual(body, original);
  });

  it("retains a byte-stable prefix across consecutive results, unchanged hits, and another tool round", async () => {
    let raw: Item[] = [{ role: "user", content: "Inspect" }, assistant("one", "parallel")];
    let previous = await applyLiveZoneCompression({ messages: raw }, options, compress);
    for (const added of [[tool("one")], [tool("parallel")], [assistant("two"), tool("two")], []]) {
      const frozen = JSON.stringify(messagesOf(previous));
      const frozenCount = raw.length;
      raw = [...raw, ...added];
      const next = await applyLiveZoneCompression({ messages: raw }, options, compress);
      const nextItems = messagesOf(next);
      assert.equal(JSON.stringify(nextItems.slice(0, frozenCount)), frozen);
      assert.equal(nextItems.length, frozenCount + added.length);
      for (let i = 0; i < added.length; i++) {
        const input = added[i] as Item;
        const output = nextItems[frozenCount + i];
        assert.equal(output.role, input.role);
        if ("tool_call_id" in input) {
          // Appended tool outputs are capped on arrival; identity must survive.
          assert.equal(output.tool_call_id, input.tool_call_id);
          assert.ok(String(output.content).length <= String(input.content).length);
        } else {
          assert.deepEqual(output, input);
        }
      }
      assert.deepEqual(next.stats?.liveZone, {
        cacheHit: true,
        frozenItems: frozenCount,
        liveItems: added.length,
      });
      previous = next;
    }
  });

  it("dedups live tools against completed-turn context on arrival", async () => {
    const run = async (body: Record<string, unknown>) => sessionDedupEngine.apply(body);
    const prefix = [{ role: "user", content: "Inspect" }];
    await applyLiveZoneCompression({ messages: prefix }, options, run);
    const live = [
      assistant("one", "duplicate"),
      tool("one"),
      tool("duplicate"),
      assistant("two"),
      tool("two"),
    ];
    const warm = await applyLiveZoneCompression({ messages: [...prefix, ...live] }, options, run);
    assert.equal(messagesOf(warm)[2].content, observation);
    assert.match(String(messagesOf(warm)[3].content), /\[dedup:ref sha=/);
    assert.match(String(messagesOf(warm)[5].content), /\[dedup:ref sha=/);
    assert.deepEqual(messagesOf(warm)[4], live[3]);
  });

  for (const boundaryInCache of [false, true]) {
    it(`keeps Responses output identity through the real body adapter with a ${boundaryInCache ? "frozen" : "live"} assistant`, async () => {
      const run = async (body: Record<string, unknown>) => {
        const adapter = adaptBodyForCompression(body);
        const result = await compress(adapter.body);
        return { ...result, body: adapter.restore(result.body) };
      };
      const boundary = { type: "message", role: "assistant", content: "Inspect both outputs" };
      const prefix: Item[] = [{ type: "message", role: "user", content: "Inspect" }];
      if (boundaryInCache) prefix.push(boundary);
      const first = await applyLiveZoneCompression({ input: prefix }, options, run);
      const live = [
        ...(boundaryInCache ? [] : [boundary]),
        { type: "function_call", call_id: "one", name: "inspect", arguments: "{}" },
        { type: "custom_tool_call", call_id: "two", name: "inspect_custom", input: "Inspect" },
        { type: "function_call_output", call_id: "one", output: observation },
        { type: "custom_tool_call_output", call_id: "two", output: observation },
      ];
      const body = { input: [...prefix, ...live] };
      const original = structuredClone(body);
      const direct = await applyLiveZoneCompression(
        body,
        { ...options, sessionId: "cold-responses-control" },
        run
      );
      const warm = await applyLiveZoneCompression(body, options, run);
      const tails = [direct, warm].map((result) => {
        const items = result.body.input as Item[];
        const tail = items.slice(items.length - live.length);
        assert.deepEqual(
          items.slice(items.length - live.length - prefix.length, items.length - live.length),
          first.body.input
        );
        // Calls keep their identity; the trailing outputs are capped on arrival.
        assert.deepEqual(tail.slice(0, live.length - 2), live.slice(0, live.length - 2));
        for (const index of [live.length - 2, live.length - 1]) {
          assert.equal(tail[index].type, live[index].type);
          assert.equal(tail[index].call_id, live[index].call_id);
        }
        return tail;
      });
      for (const tail of tails) {
        assert.notEqual(tail[live.length - 2].output, observation, "linked output is capped");
      }
      assert.notEqual(tails[0][live.length - 1].output, observation, "cold control caps both");
      assert.deepEqual(body, original);
    });
  }

  it("does not expose caller-owned items to a mutating warm compressor", async () => {
    let calls = 0;
    const run = async (body: Record<string, unknown>): Promise<CompressionResult> => {
      if (++calls > 1) {
        for (const item of body.messages as Item[]) item.content = "changed by compressor";
      }
      return { body, compressed: false, stats: null };
    };
    const prefix = [{ role: "user", content: "Inspect" }];
    await applyLiveZoneCompression({ messages: prefix }, options, run);
    const body = { messages: [...prefix, assistant("one"), tool("one"), assistant("done")] };
    const original = structuredClone(body);
    const warm = await applyLiveZoneCompression(body, options, run);
    assert.deepEqual(body, original);
    assert.deepEqual(messagesOf(warm)[1], original.messages[1]);
    assert.deepEqual(messagesOf(warm)[3], original.messages[3]);
  });

  it("does not cache a cold transform whose cardinality cannot be mapped to raw items", async () => {
    let calls = 0;
    const run = async (body: Record<string, unknown>): Promise<CompressionResult> => {
      if (++calls === 1) {
        return { body: { messages: [] }, compressed: true, stats: null };
      }
      return compress(body);
    };
    const prefix = [{ role: "user", content: "Inspect" }, assistant("one")];
    await applyLiveZoneCompression({ messages: prefix }, options, run);
    const body = { messages: [...prefix, tool("one")] };
    const next = await applyLiveZoneCompression(body, options, run);
    const items = messagesOf(next);
    assert.deepEqual(items.slice(0, prefix.length), body.messages.slice(0, prefix.length));
    // The cold transform is not reused as a cached prefix; its own arrival output is sent.
    assert.ok(String(items[2].content).endsWith("...[truncated]"));
    assert.equal(next.stats?.liveZone, undefined, "unmappable cold output must force a cache miss");
  });

  for (const malformed of [undefined, [], [{ role: "tool", content: "wrong slot" }]]) {
    it(`keeps all live items when contextual compression returns ${JSON.stringify(malformed)}`, async () => {
      let calls = 0;
      const run = async (body: Record<string, unknown>): Promise<CompressionResult> => {
        if (++calls === 1) return { body, compressed: false, stats: null };
        return { body: { ...body, messages: malformed }, compressed: true, stats: null };
      };
      const prefix = [{ role: "user", content: "Inspect" }];
      await applyLiveZoneCompression({ messages: prefix }, options, run);
      const body = {
        messages: [...prefix, assistant("old"), tool("old"), assistant("current"), tool("current")],
      };
      const next = await applyLiveZoneCompression(body, options, run);
      assert.deepEqual(next.body.messages, body.messages);
    });
  }
});
