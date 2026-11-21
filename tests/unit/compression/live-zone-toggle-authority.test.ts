/**
 * The "Cache-aligned Live Zone" toggle must be authoritative once saved. OpenCode's
 * automatic-prefix-cache lanes are forced into the lane (#18787) so compression stops
 * churning the implicit upstream cache — but that force must not outlive an explicit
 * `{"enabled":false}` saved from the dashboard (`liveZoneExplicit`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldRunLiveZoneLane } from "../../../open-sse/handlers/chatCore/liveZoneGate.ts";
import type { CompressionConfig } from "../../../open-sse/services/compression/types.ts";

const config = (overrides: Partial<CompressionConfig>): CompressionConfig =>
  ({ enabled: true, liveZone: { enabled: false }, ...overrides }) as CompressionConfig;

describe("shouldRunLiveZoneLane", () => {
  it("stays off when the toggle is off and the request is not an OpenCode lane", () => {
    assert.equal(shouldRunLiveZoneLane(config({}), false), false);
  });

  it("keeps the OpenCode cache protection on an install that never saved the toggle", () => {
    assert.equal(shouldRunLiveZoneLane(config({ liveZoneExplicit: false }), true), true);
    assert.equal(shouldRunLiveZoneLane(config({}), true), true);
  });

  it("honors an explicit disable even on the OpenCode lane", () => {
    assert.equal(shouldRunLiveZoneLane(config({ liveZoneExplicit: true }), true), false);
  });

  it("runs when the toggle is on, with or without the OpenCode lane", () => {
    assert.equal(
      shouldRunLiveZoneLane(config({ liveZone: { enabled: true }, liveZoneExplicit: true }), false),
      true
    );
    assert.equal(
      shouldRunLiveZoneLane(config({ liveZone: { enabled: true }, liveZoneExplicit: true }), true),
      true
    );
  });
});
