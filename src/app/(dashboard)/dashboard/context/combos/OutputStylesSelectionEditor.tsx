"use client";

// Backport of the engine panel's unified output-styles selection (Phase 4A) into
// the compression-combo editor. Instruction text and styles come from the same
// open-sse catalog the settings panel drives, so no behavior drift: whatever the
// combo picks here is merged into config.outputStyles at request time.
import { useLocale, useTranslations } from "next-intl";
import {
  OUTPUT_STYLE_IDS,
  outputStyleMeta,
} from "../../../../../../open-sse/services/compression/outputStyles/catalog.ts";

type Level = "lite" | "full" | "ultra";
const LEVELS: Level[] = ["lite", "full", "ultra"];

export interface OutputStyleEntry {
  id: string;
  level: string;
}

export function OutputStylesSelectionEditor({
  value,
  onChange,
  disabled,
}: {
  value: OutputStyleEntry[];
  onChange: (next: OutputStyleEntry[]) => void;
  disabled?: boolean;
}) {
  const tSettings = useTranslations("settings");
  const uiLang = (useLocale() || "en").split("-")[0];

  const setStyle = (id: string, patch: { enabled?: boolean; level?: Level }) => {
    const existing = value.find((s) => s.id === id);
    let next = value;
    if (patch.enabled === false) {
      next = value.filter((s) => s.id !== id);
    } else {
      const level = patch.level ?? existing?.level ?? "full";
      next = existing
        ? value.map((s) => (s.id === id ? { id, level } : s))
        : [...value, { id, level }];
    }
    // Persist in catalog order so injection order is stable.
    onChange(
      OUTPUT_STYLE_IDS.filter((sid) => next.some((s) => s.id === sid)).map(
        (sid) => next.find((s) => s.id === sid) as OutputStyleEntry
      )
    );
  };

  return (
    <div
      className="mt-2 space-y-2 border-t border-border/30 pt-2"
      data-testid="output-styles-editor"
    >
      <p className="text-sm font-medium text-text-main">
        {tSettings("compressionSettingsOutputStyles")}
      </p>
      <p className="text-xs text-text-muted">{tSettings("compressionOutputStylesDescription")}</p>
      {OUTPUT_STYLE_IDS.filter((id) => {
        const m = outputStyleMeta(id);
        return !m?.locale || m.locale === uiLang;
      }).map((id) => {
        const meta = outputStyleMeta(id);
        const sel = value.find((s) => s.id === id);
        return (
          <div
            key={id}
            data-testid={`combo-output-style-row-${id}`}
            className="flex items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <span className="text-sm text-text-main">
                {tSettings(`compressionOutputStyle.${id}.label`)}
              </span>
              {meta?.description && (
                <p className="text-xs text-text-muted">
                  {tSettings(`compressionOutputStyle.${id}.description`)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <select
                data-testid={`combo-output-style-level-${id}`}
                value={sel?.level ?? "full"}
                onChange={(e) => setStyle(id, { level: e.target.value as Level })}
                disabled={!sel || disabled}
                aria-label={tSettings(`compressionOutputStyle.${id}.label`)}
                className="w-24 rounded border border-border bg-bg px-2 py-1 text-xs text-text-main"
              >
                {LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {tSettings(`compressionLevel.${lvl}`)}
                  </option>
                ))}
              </select>
              <input
                type="checkbox"
                checked={Boolean(sel)}
                onChange={(e) => setStyle(id, { enabled: e.target.checked })}
                disabled={disabled}
                aria-label={tSettings(`compressionOutputStyle.${id}.label`)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
