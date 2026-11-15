import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyOutputStyles,
  OUTPUT_STYLE_MARKER,
  resetOutputStyleSessionLatch,
  type OutputStyleSelectionEntry,
} from "../../../open-sse/services/compression/outputStyles/apply.ts";

const sel = (...entries: Array<[string, "lite" | "full" | "ultra"]>): OutputStyleSelectionEntry[] =>
  entries.map(([id, level]) => ({ id, level }));

const user = (content: string) => ({ role: "user", content });

beforeEach(() => resetOutputStyleSessionLatch());

// Every injection changes the system prompt, and every change invalidates the provider
// prompt cache for the whole conversation. The bypass decision therefore latches toward
// styling: at most one flip (off -> on) per session, never on -> off.
test("a styled session stays styled when a later turn mentions security", () => {
  const first = applyOutputStyles(
    { messages: [user("Summarize this API response.")] },
    sel(["terse-prose", "full"]),
    "en",
    { sessionId: "session-latch-on" }
  );
  assert.equal(first.applied, true);

  const second = applyOutputStyles(
    {
      messages: [
        user("Summarize this API response."),
        { role: "assistant", content: "Done." },
        user("Now explain this security vulnerability."),
      ],
    },
    sel(["terse-prose", "full"]),
    "en",
    { sessionId: "session-latch-on" }
  );
  assert.equal(second.applied, true, "a styled session must not flip styling off");
  assert.match(
    String(second.body.messages?.at(-1)?.content),
    new RegExp(OUTPUT_STYLE_MARKER),
    "style instruction text stays byte-identical for the session"
  );
});

test("a session whose first prompt bypasses still styles once the keyword is gone", () => {
  const first = applyOutputStyles(
    { messages: [user("Explain this security vulnerability in detail.")] },
    sel(["terse-prose", "full"]),
    "en",
    { sessionId: "session-latch-off" }
  );
  assert.equal(first.applied, false);
  assert.equal(first.skippedReason, "security_warning");

  const second = applyOutputStyles(
    {
      messages: [
        user("Explain this security vulnerability in detail."),
        { role: "assistant", content: "It is a buffer overflow." },
        user("Now summarize the fix."),
      ],
    },
    sel(["terse-prose", "full"]),
    "en",
    { sessionId: "session-latch-off" }
  );
  assert.equal(second.applied, true, "a bypassed session is re-evaluated every request");
});

test("different session ids decide independently", () => {
  applyOutputStyles(
    { messages: [user("Summarize this API response.")] },
    sel(["terse-prose", "full"]),
    "en",
    {
      sessionId: "session-a",
    }
  );
  const bypassed = applyOutputStyles(
    { messages: [user("Explain this security vulnerability in detail.")] },
    sel(["terse-prose", "full"]),
    "en",
    { sessionId: "session-b" }
  );
  assert.equal(bypassed.applied, false);
  assert.equal(bypassed.skippedReason, "security_warning");
});

test("a different style selection gets a fresh decision", () => {
  applyOutputStyles(
    { messages: [user("Summarize this API response.")] },
    sel(["terse-prose", "full"]),
    "en",
    {
      sessionId: "session-config",
    }
  );
  const reconfigured = applyOutputStyles(
    { messages: [user("Explain this security vulnerability in detail.")] },
    sel(["terse-prose", "ultra"]),
    "en",
    { sessionId: "session-config" }
  );
  assert.equal(reconfigured.applied, false);
  assert.equal(reconfigured.skippedReason, "security_warning");
});

test("requests without a session id keep per-request bypass behavior", () => {
  const styled = applyOutputStyles(
    { messages: [user("Summarize this API response.")] },
    sel(["terse-prose", "full"])
  );
  assert.equal(styled.applied, true);
  const bypassed = applyOutputStyles(
    { messages: [user("Explain this security vulnerability in detail.")] },
    sel(["terse-prose", "full"])
  );
  assert.equal(bypassed.applied, false);
  assert.equal(bypassed.skippedReason, "security_warning");
});
