// Unit tests for claude-agent CLI session resume helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  forgetCliSessionId,
  rememberCliSessionId,
  resumeIdFor,
  resumePrompt,
} from "../../open-sse/executors/claude-agent.ts";

describe("resume session map", () => {
  it("stores and returns a session id keyed by sessionKey", () => {
    forgetCliSessionId("k1");
    assert.equal(resumeIdFor("k1"), null);
    rememberCliSessionId("k1", "sess-1");
    assert.equal(resumeIdFor("k1"), "sess-1");
    rememberCliSessionId("k1", "sess-2");
    assert.equal(resumeIdFor("k1"), "sess-2");
    forgetCliSessionId("k1");
    assert.equal(resumeIdFor("k1"), null);
  });

  it("ignores empty keys and ids", () => {
    rememberCliSessionId(null, "sess-x");
    rememberCliSessionId("k2", undefined);
    rememberCliSessionId("k2", "");
    assert.equal(resumeIdFor("k2"), null);
  });

  it("caps the map at 1000 entries, pruning the oldest", () => {
    for (let i = 0; i < 1005; i++) rememberCliSessionId(`cap-${i}`, `s-${i}`);
    assert.equal(resumeIdFor("cap-0"), null, "oldest pruned");
    assert.equal(resumeIdFor("cap-4"), null, "pruned past cap");
    assert.equal(resumeIdFor("cap-5"), "s-5", "survives at cap boundary");
    assert.equal(resumeIdFor("cap-1004"), "s-1004");
    for (let i = 0; i < 1005; i++) forgetCliSessionId(`cap-${i}`);
  });
});

describe("resumePrompt", () => {
  it("sends only the latest user turn, not the full history", async () => {
    const yielded = [];
    for await (const m of resumePrompt({
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    })) {
      yielded.push(m);
    }
    assert.equal(yielded.length, 1);
    assert.deepEqual(yielded[0].message, { role: "user", content: "q2" });
    assert.equal(yielded[0].shouldQuery, true);
  });

  it("rides a trailing assistant prefill after the last user message", async () => {
    const yielded = [];
    for await (const m of resumePrompt({
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "prefill" },
      ],
    })) {
      yielded.push(m);
    }
    assert.equal(yielded.length, 2);
    assert.deepEqual(yielded[0].message, { role: "user", content: "q2" });
    assert.deepEqual(yielded[1].message, { role: "assistant", content: "prefill" });
    assert.equal(yielded[0].shouldQuery, false, "trigger is the prefill");
    assert.equal(yielded[1].shouldQuery, true);
  });

  it("falls back to a Continue nudge when no user message exists", async () => {
    const yielded = [];
    for await (const m of resumePrompt({ messages: [] })) {
      yielded.push(m);
    }
    assert.equal(yielded.length, 1);
    assert.deepEqual(yielded[0].message, { role: "user", content: "Continue." });
    assert.equal(yielded[0].shouldQuery, true);
  });
});
