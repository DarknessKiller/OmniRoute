/**
 * `liveZone.enabled` is the dashboard toggle. OpenCode's automatic-prefix-cache lanes are also
 * forced into the lane (#18787) — but only until the operator saves the toggle, otherwise
 * "disabled" in the UI would silently do nothing (`liveZoneExplicit`, set by the settings read).
 */

import type { CompressionConfig } from "../../services/compression/types.ts";

export function shouldRunLiveZoneLane(
  config: CompressionConfig,
  protectOpenCodePrefix: boolean
): boolean {
  if (config.liveZone?.enabled === true) return true;
  return protectOpenCodePrefix && config.liveZoneExplicit !== true;
}
