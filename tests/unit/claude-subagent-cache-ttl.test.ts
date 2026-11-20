// @ts-nocheck
/**
 * Claude Code subagents must keep Anthropic's 5-minute cache-write tier.
 *
 * The CLI sends a subagent with bare `{"type":"ephemeral"}` markers and no
 * extended-cache-ttl beta, and Anthropic bills those writes at 1.25x. The native
 * claude dispatch used to run normalizeCacheControlTtl() unconditionally, which
 * materializes `ttl:"1h"` on every bare marker — silently moving 100% of a
 * subagent's cache writes into the 2x 1h pool (measured: 357k tokens per session
 * at $30/M instead of $18.75/M). CLIProxyAPI reaches the same wire result by
 * stripping subagent TTLs (claude_executor_cloaking.go isClaudeSubagentRequestDoc
 * / claudeSubagentRequests1hDoc); this test pins that rule end-to-end through
 * handleChatCore.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc-subagent-ttl-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const originalFetch = globalThis.fetch;

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createSseResponse() {
  return new Response(
    [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-sonnet-5"}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n") + "\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

/** Markers of a Claude Code subagent: three bare ephemeral breakpoints, no ttl. */
function subagentBody(ttl) {
  const marker = ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
  return {
    model: "claude/claude-sonnet-5",
    max_tokens: 1024,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "Repo context", cache_control: { ...marker } },
    ],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      {
        role: "user",
        content: [{ type: "text", text: "u2", cache_control: { ...marker } }],
      },
    ],
  };
}

async function captureUpstream({ body, headers, userAgent }) {
  let upstreamBody = null;
  globalThis.fetch = async (_url, init = {}) => {
    upstreamBody = JSON.parse(String(init.body || "{}"));
    return createSseResponse();
  };

  await handleChatCore({
    body,
    modelInfo: { provider: "claude", model: "claude-sonnet-5", extendedContext: false },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: noopLog(),
    clientRawRequest: {
      endpoint: "/v1/messages",
      body: structuredClone(body),
      headers: new Headers({ "content-type": "application/json", ...headers }),
    },
    userAgent,
  });

  assert.ok(upstreamBody, "upstream fetch captured the request body");
  return upstreamBody;
}

/** Every cache_control ttl that reached the wire, in prompt order. */
function wireTtls(body) {
  const ttls = [];
  const visit = (block) => {
    if (block?.cache_control) ttls.push(block.cache_control.ttl ?? "(default)");
  };
  if (Array.isArray(body.tools)) body.tools.forEach(visit);
  if (Array.isArray(body.system)) body.system.forEach(visit);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (Array.isArray(message.content)) message.content.forEach(visit);
    }
  }
  return ttls;
}

const CLAUDE_CODE_UA = "claude-cli/2.1.323 (external, cli)";

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("a subagent's bare markers stay on Anthropic's 5m tier", async () => {
  const upstream = await captureUpstream({
    body: subagentBody(),
    headers: { "x-app": "cli", "x-claude-code-agent-id": "agent-sub-1" },
    userAgent: CLAUDE_CODE_UA,
  });

  const ttls = wireTtls(upstream);
  assert.ok(ttls.length > 0, "client breakpoints must reach the upstream");
  assert.ok(
    !ttls.includes("1h"),
    `subagent writes must not enter the 1h tier, got ${JSON.stringify(ttls)}`
  );
});

test("a subagent marked by metadata.user_id.parent_session_id has its explicit 1h stripped", async () => {
  const body = subagentBody("1h");
  body.metadata = {
    user_id: JSON.stringify({ device_id: "d", account_uuid: "a", parent_session_id: "p" }),
  };

  const upstream = await captureUpstream({
    body,
    headers: { "x-app": "cli" },
    userAgent: CLAUDE_CODE_UA,
  });

  const ttls = wireTtls(upstream);
  assert.ok(ttls.length > 0, "client breakpoints must reach the upstream");
  assert.ok(!ttls.includes("1h"), `subagent 1h must be stripped, got ${JSON.stringify(ttls)}`);
});

test("a subagent that negotiated extended-cache-ttl keeps its 1h", async () => {
  const upstream = await captureUpstream({
    body: subagentBody("1h"),
    headers: {
      "x-app": "cli",
      "x-claude-code-agent-id": "agent-sub-2",
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
    },
    userAgent: CLAUDE_CODE_UA,
  });

  const ttls = wireTtls(upstream);
  assert.ok(ttls.includes("1h"), `opted-in subagent keeps 1h, got ${JSON.stringify(ttls)}`);
});

test("the main thread keeps its explicit 1h", async () => {
  const upstream = await captureUpstream({
    body: subagentBody("1h"),
    headers: { "x-app": "cli", "anthropic-beta": "extended-cache-ttl-2025-04-11" },
    userAgent: CLAUDE_CODE_UA,
  });

  const ttls = wireTtls(upstream);
  assert.ok(ttls.includes("1h"), `main thread keeps 1h, got ${JSON.stringify(ttls)}`);
});
