-- Backport output styles to compression combos: a combo can carry the same
-- `outputStyles` selection ({id, level}) as the engine-settings panel. Empty
-- array keeps the legacy `output_mode_intensity` terse-prose behavior.
ALTER TABLE compression_combos ADD COLUMN output_styles TEXT NOT NULL DEFAULT '[]';
