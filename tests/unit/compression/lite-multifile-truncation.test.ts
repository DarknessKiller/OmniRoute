/**
 * Lite caps a concatenated multi-file read per file, not as one blob: one large file must not
 * consume the whole budget and hide the files after it. Splitting is byte-exact, refuses prose
 * that merely resembles headers, and stays idempotent on a second pass.
 * Run: node --import tsx/esm --test tests/unit/compression/lite-multifile-truncation.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compressToolResults } from "../../../open-sse/services/compression/lite.ts";

const MAX = 300;
const MARKER = "\n...[truncated]";

type Msg = { role: string; content: unknown; [key: string]: unknown };

function body(name: string, lines = 100): string {
  return Array.from({ length: lines }, (_, i) => `${name} line ${i + 1}`).join("\n");
}

function bundle(names: string[], header: (name: string) => string): string {
  return names.map((name) => `${header(name)}\n${body(name)}`).join("\n");
}

function compress(content: string, maxToolLength = MAX) {
  return compressToolResults({ messages: [{ role: "tool", content } as Msg] }, { maxToolLength });
}

/** Sections of the compressed text, split at the same headers the engine recognises. */
function sectionsOf(text: string): string[] {
  return text.split(/\n(?=(?:-{3} |=== |<file path=|path: |[^\s:]+:\n))/);
}

function assertPerFileCapped(text: string, expectedFiles: number): void {
  const sections = sectionsOf(text);
  assert.equal(sections.length, expectedFiles);
  for (const section of sections) {
    assert.ok(section.length <= MAX, `section exceeds cap: ${section.length}`);
    assert.ok(section.endsWith(MARKER), "each oversized file section keeps its own marker");
  }
  assert.equal(text.split(MARKER).length - 1, expectedFiles);
}

describe("lite multi-file tool-result truncation", () => {
  it("caps a Gemini read_many_files bundle per file", () => {
    const text = bundle(["a.py", "b.py", "c.py"], (name) => `--- ${name} ---`);
    const result = compress(text);

    assert.equal(result.applied, true);
    const out = String((result.body.messages as Msg[])[0].content);
    assertPerFileCapped(out, 3);
    for (const name of ["a.py", "b.py", "c.py"]) {
      assert.ok(out.includes(`--- ${name} ---`), `header kept: ${name}`);
      assert.ok(out.includes(`${name} line 1\n`), `first line kept: ${name}`);
      assert.ok(out.includes(`${name} line 100`), `last line kept: ${name}`);
    }
  });

  it("caps an MCP read_multiple_files bundle per file", () => {
    const text = bundle(["a.py", "b.py"], (name) => `${name}:`);
    const out = String(compress(text).body.messages![0].content);

    assertPerFileCapped(out, 2);
    assert.ok(out.includes("a.py:"));
    assert.ok(out.includes("b.py:"));
  });

  it("caps a <file path=...> bundle per file", () => {
    const text = bundle(["a.py", "b.py"], (name) => `<file path="${name}">`);
    const out = String(compress(text).body.messages![0].content);

    assertPerFileCapped(out, 2);
  });

  it("stays a single blob when a header is not file-like or prose precedes it", () => {
    const prose = `Results:\n${bundle(["a.py", "b.py"], (name) => `--- ${name} ---`)}`;
    const proseOut = String(compress(prose).body.messages![0].content);
    assert.equal(proseOut.split(MARKER).length - 1, 1);
    assert.ok(proseOut.length <= MAX);

    const notPaths = `note:\n${body("first", 40)}\nnote:\n${body("second", 40)}`;
    const notPathsOut = String(compress(notPaths).body.messages![0].content);
    assert.equal(notPathsOut.split(MARKER).length - 1, 1);

    const single = `--- a.py ---\n${body("a", 100)}`;
    assert.equal(String(compress(single).body.messages![0].content).split(MARKER).length - 1, 1);
  });

  it("is idempotent and leaves a bundle whose files all fit untouched", () => {
    const text = bundle(["a.py", "b.py", "c.py"], (name) => `--- ${name} ---`);
    const first = compress(text);
    const out = String((first.body.messages as Msg[])[0].content);
    const second = compress(out, MAX);

    assert.deepEqual(second.body, first.body);
    assert.equal(second.applied, false);

    // Eight files, each under the cap: the bundle is over the cap but nothing needs cutting.
    const small = ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py", "g.py", "h.py"]
      .map((name) => `--- ${name} ---\n${body(name, 10)}`)
      .join("\n");
    const smallOut = compress(small);
    assert.equal(smallOut.applied, false);
    assert.equal(String(smallOut.body.messages![0].content), small);
  });
});
