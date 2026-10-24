import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCompressionComboIntoConfig } from "../../open-sse/handlers/chatCore/compressionComboConfig.ts";

function baseConfig() {
  return {
    enabled: true,
    comboOverrides: {},
  } as Parameters<typeof mergeCompressionComboIntoConfig>[0];
}

function combo(extra: Partial<Parameters<typeof mergeCompressionComboIntoConfig>[1]> = {}) {
  return {
    id: "combo-1",
    pipeline: [{ engine: "caveman", intensity: "full" }],
    languagePacks: ["en"],
    outputMode: false,
    outputModeIntensity: "full",
    ...extra,
  };
}

test("combo outputStyles propagate into config.outputStyles (backport)", () => {
  const merged = mergeCompressionComboIntoConfig(
    baseConfig(),
    combo({ outputMode: true, outputStyles: [{ id: "terse-prose", level: "ultra" }] }),
    []
  );
  assert.ok(merged);
  assert.deepEqual(merged.outputStyles, [{ id: "terse-prose", level: "ultra" }]);
  assert.equal(merged.cavemanOutputMode?.enabled, true);
});

test("combo without outputStyles keeps the legacy intensity path", () => {
  const merged = mergeCompressionComboIntoConfig(
    baseConfig(),
    combo({ outputMode: true, outputModeIntensity: "ultra" }),
    []
  );
  assert.ok(merged);
  assert.equal(merged.outputStyles, undefined);
  assert.equal(merged.cavemanOutputMode?.intensity, "ultra");
});

test("invalid style entries in the combo are dropped", () => {
  const merged = mergeCompressionComboIntoConfig(
    baseConfig(),
    combo({
      outputMode: true,
      outputStyles: [
        { id: "terse-prose", level: "full" },
        { id: "nonexistent", level: "full" },
      ],
    }),
    []
  );
  assert.ok(merged);
  assert.deepEqual(merged.outputStyles, [{ id: "terse-prose", level: "full" }]);
});

test("explicit combo outputStyles win over legacy intensity (resolveOutputStyleSelection precedence)", () => {
  const merged = mergeCompressionComboIntoConfig(
    baseConfig(),
    combo({
      outputMode: true,
      outputModeIntensity: "lite",
      outputStyles: [{ id: "ponytail", level: "full" }],
    }),
    []
  );
  assert.ok(merged);
  assert.deepEqual(merged.outputStyles, [{ id: "ponytail", level: "full" }]);
  assert.equal(merged.cavemanOutputMode?.intensity, "lite");
});
