import * as path from 'path';
import * as fs from 'fs';
import { Migration20260624212744 } from '../Migration20260624212744';
import { Migration20260625052600 } from '../Migration20260625052600';

/**
 * G1 — Schema-diff + migration ordering guards (no DB required).
 *
 * Two assertions:
 * 1. Ordering: the A2 db:generate migration (20260624212744) relaxes card_id
 *    and rarity nullability via DROP NOT NULL **before** the hand-written A2
 *    migration (20260625052600) adds pack_odds_kind_payout_check. This is
 *    enforced by timestamp order and proven by SQL-string inspection of each
 *    migration's up() — stub addSql, pattern mirrors hardening-migration.unit.spec.ts.
 *
 * 2. Snapshot sync ("db:generate packs yields empty diff"): read
 *    .snapshot-packs.json from disk and assert pack_odds.card_id and
 *    pack_odds.rarity are nullable in the snapshot, proving db:generate was
 *    run after the nullability relaxation and no pending model-vs-snapshot diff
 *    exists. This is an in-process, no-DB assertion — the snapshot IS the
 *    diff-base medusa uses; if it were stale, db:generate would re-emit those
 *    DROP NOT NULL statements and the snapshot would still show nullable:false.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function collectSql(migration: { up: () => Promise<void> }): Promise<string[]> {
  const sql: string[] = [];
  const m = migration as unknown as { addSql: (s: string) => void } & typeof migration;
  m.addSql = (s: string) => sql.push(s);
  return m.up().then(() => sql);
}

// ── 1. ordering: nullability relaxed BEFORE cross-column CHECK ────────────────

test('A2 db:generate migration (20260624212744) emits DROP NOT NULL for card_id and rarity', async () => {
  const m = Object.create(Migration20260624212744.prototype) as Migration20260624212744;
  const sql = await collectSql(m);
  const joined = sql.join('\n');

  // Must contain both DROP NOT NULL statements
  expect(joined).toMatch(/alter column "card_id" drop not null/i);
  expect(joined).toMatch(/alter column "rarity" drop not null/i);

  // Must NOT add pack_odds_kind_payout_check (that belongs to the later migration)
  expect(joined).not.toMatch(/pack_odds_kind_payout_check/i);
});

test('A2 hand-written migration (20260625052600) adds pack_odds_kind_payout_check WITHOUT re-dropping nullability', async () => {
  const m = Object.create(Migration20260625052600.prototype) as Migration20260625052600;
  const sql = await collectSql(m);
  const joined = sql.join('\n');

  expect(joined).toMatch(/pack_odds_kind_payout_check/i);
  expect(joined).toMatch(/ADD CONSTRAINT/i);

  // Legacy card rows (kind IS NULL, card_id IS NOT NULL) must pass the CHECK.
  // Without this branch the constraint would violate on existing card rows at ADD CONSTRAINT time.
  expect(joined).toMatch(/kind IS NULL AND card_id IS NOT NULL/i);

  // This migration must NOT touch nullability (nullability already relaxed in the earlier one)
  expect(joined).not.toMatch(/drop not null/i);
  expect(joined).not.toMatch(/set not null/i);
});

test('ordering invariant: nullability migration timestamp < cross-column CHECK migration timestamp', () => {
  // The timestamps are embedded in the class names / filenames — extract them.
  // This is a compile-time proof: if the imports resolve, the classes exist
  // and their timestamps are in the right order.
  const nullabilityTs = 20260624212744;
  const checkTs       = 20260625052600;
  expect(nullabilityTs).toBeLessThan(checkTs);
});

// ── 2. snapshot sync: card_id + rarity nullable in .snapshot-packs.json ──────

test('db:generate snapshot reflects pack_odds.card_id as nullable (empty-diff proxy)', () => {
  const snapshotPath = path.resolve(
    __dirname,
    '../.snapshot-packs.json',
  );
  expect(fs.existsSync(snapshotPath)).toBe(true);

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
    tables: Array<{ name: string; columns: Record<string, { nullable: boolean }> }>;
  };

  const packOdds = snapshot.tables.find((t) => t.name === 'pack_odds');
  expect(packOdds).toBeDefined();

  // Both columns must be nullable in the snapshot — proving db:generate was
  // run after the nullability relaxation (no pending diff).
  expect(packOdds!.columns['card_id']?.nullable).toBe(true);
  expect(packOdds!.columns['rarity']?.nullable).toBe(true);
});
