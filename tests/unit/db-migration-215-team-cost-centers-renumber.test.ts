/**
 * tests/unit/db-migration-215-team-cost-centers-renumber.test.ts
 *
 * The fork carried `compression_combos_output_styles` as migration 215 before the
 * upstream sync; upstream had since renumbered it to 220 and handed 215 to
 * `team_cost_centers`. `isSchemaAlreadyApplied` still answered "already applied"
 * for 215, so on an existing database team_cost_centers was recorded in the
 * ledger without creating its tables and 216_team_cost_shapes then failed with
 * `no such table: daily_team_usage_summary` at boot.
 *
 * Strategy: initialize a database, rewind it to the pre-sync ledger state
 * (215 = output styles, team tables absent), re-initialize and assert the team
 * tables are created and the ledger ends up with 215 = team_cost_centers and
 * 220 = compression_combos_output_styles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-215-team-cost-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");

const TEAM_TABLES = ["teams", "api_key_billing_team_history", "daily_team_usage_summary"];

function tableNames(db: any): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row: { name: string }) => row.name);
}

test("215_team_cost_centers still creates its tables after the output-styles renumber", () => {
  const db = core.getDbInstance();

  for (const table of TEAM_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.prepare("DELETE FROM _omniroute_migrations WHERE version = ? AND name = ?").run(
    "215",
    "team_cost_centers"
  );
  db.prepare(
    "UPDATE _omniroute_migrations SET version = ?, name = ? WHERE version = ? AND name = ?"
  ).run("215", "compression_combos_output_styles", "220", "compression_combos_output_styles");
  core.resetDbInstance();

  const replayed = core.getDbInstance();
  const tables = tableNames(replayed);
  for (const table of TEAM_TABLES) {
    assert.ok(tables.includes(table), `expected '${table}' to exist. Found: ${tables.join(", ")}`);
  }

  const ledger = replayed
    .prepare("SELECT version, name FROM _omniroute_migrations WHERE version IN ('215', '220')")
    .all() as Array<{ version: string; name: string }>;
  const byName = new Map(ledger.map((row) => [row.version, row.name]));
  assert.equal(byName.get("215"), "team_cost_centers");
  assert.equal(byName.get("220"), "compression_combos_output_styles");
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
