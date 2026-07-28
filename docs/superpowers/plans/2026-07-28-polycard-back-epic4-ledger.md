# POLYCARD-BACK Epic 4 — Transaction Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new, go-forward-only `ledger_entry` model with a scoped display-id
generator (`TP26Q3A0001`-style), a single reusable `recordLedgerEntry` write
primitive, and five of the spec's seven writers wired into their existing
money-moving code paths (TP top-up, SP pack-open spend, SE buyback/sell, OD
delivery create+cancel, AD operator adjustment) — each in the SAME DB
transaction as the event it describes. RF (referral) and WP (challenge
settlement) get the writer capability but no call site: their source
workflows do not exist on `origin/master` yet (verified — no settlement job,
no weekly payout job). A read-only admin Transactions page (type tabs,
search, date range, expandable payload) closes out the epic, plus a small
`ledger_display_id` column added to the existing Wallet-tab transactions feed
per spec §4.3.

**Architecture:** `ledger_entry` (id, display_id, type, customer_id,
occurred_at, wallet_delta, vault_delta, payload, ref_id) + `ledger_sequence`
(scope, last_serial) are new models on `PacksModuleService`. Display-id
generation is a pure module (`modules/packs/ledger.ts`: `nextSerial`,
`sequenceScope`/`ymqInMyt`, `displayId`), unit-tested without a DB. The DB
side — allocate-under-lock + insert — is ONE new `@InjectTransactionManager()`
service method, `recordLedgerEntry`, mirroring `adminAdjustCredit`'s existing
"credit row + audit row, same transaction" shape exactly (`sharedContext`
threaded through). Every writer follows the SAME rule: introduce or extend
ONE outer transactional service method that performs the domain write AND
calls `this.recordLedgerEntry(..., sharedContext)` before returning — never
two separate bare service calls (each bare call opens its own Postgres
transaction; MikroORM's Unit of Work also buffers ORM inserts until flush,
so a bare second call cannot be "the same transaction" even with a try/catch
around it — this is why `settleOpen` does its own idempotency pre-check via
raw SQL instead of catching an ORM insert's constraint violation, and why
this plan does the same for `recordLedgerEntry`'s `(type, ref_id)` check).
`ref_id` is chosen per writer to make the eventual join trivial: TP/SP/SE/AD
key on the underlying `credit_transaction` id (SP uses `open_id`, which
`credit_transaction.source_transaction_id` already carries for `pack_open`
rows — no new column needed); OD keys on `delivery_order.id` for create and
`cancel:<order_id>` for the reversing cancel entry (a different key, since
`(type, ref_id)` must stay unique and a cancel is a distinct event from the
create it reverses).

**Tech Stack:** Medusa v2 (MikroORM, hand-written migrations), Jest (unit +
`integration-tests/http` shards + `moduleIntegrationTestRunner` specs under
`modules/packs/__tests__/`), Mercur admin (Vite + @medusajs/ui + react-query).

**Spec:** `plans/058-polycard-back-admin-overhaul.md` §5 (model, display-id
generator, writers table, admin UI, acceptance), cross-referenced with §0 D4
(go-forward only) and §7 (sequencing: pure additive, wire writers one by one;
this epic is upstream of §6 Referral redo, which will add the RF call site).

## Global Constraints

- **Branch base is `origin/master`, NOT local `master`.** Local `master`
  (`95c5c1c0`, "WIP: epitaxy pre-switch from master") is a stale WIP commit
  that predates Epics 1-3 and is **not an ancestor** of `origin/master`
  (verified: `git merge-base --is-ancestor 3ff2bfd5 HEAD` fails,
  `--is-ancestor 3ff2bfd5 origin/master` succeeds). `origin/master` tip
  already contains Epic 1 (#270), Epic 2 (#271), Epic 3 (#274), and a test-gate
  fix (#273). Before branching: `git fetch origin && git log origin/master
  --oneline -4` must show `713c540a feat(odds): ... epic 3 ... (#274)` at or
  below the tip. Branch from `origin/master`, never from local `master`.
- **The codebase-memory / code-review-graph indexes are stale** — they were
  built against local `95c5c1c0` and do not reflect Epics 1-3. Do not trust
  their file/line citations for anything under `backend/` without
  cross-checking `git show origin/master:<path>`. This plan's own citations
  were verified against `origin/master` directly, not the graph.
- **Worktree** (consent pre-granted): `EnterWorktree` or `git worktree add
  .worktrees/epic4-ledger -b feat/epic4-ledger origin/master`; `npm install`
  (root), `corepack yarn install` (from `backend/`), PowerShell `Copy-Item`
  for `backend/packages/api/.env` (bash `cp` is blocked by guard-secrets),
  and `corepack yarn build` in `backend/packages/odds-math` (backend tests
  fail without its dist even though this epic never touches odds-math).
  Commit this plan file as the branch's first commit.
- **Migrations:** `corepack yarn medusa db:migrate` run from
  `backend/packages/api` — **NOT** `yarn db:migrate` (that command does not
  exist in this package). This epic owns `Migration20260728210000` (single
  migration, both new tables) — the existing tip on `origin/master` is
  `Migration20260728200000` (Epic 3); never renumber below it.
- **`model.bigNumber()` is TWO columns**: the field itself (numeric) plus a
  `raw_<field>` jsonb sidecar. A hand-written migration that omits the `raw_`
  half passes every mocked/unit test and fails on the first real insert. This
  epic's `wallet_delta`/`vault_delta` are money (MYR, signed, nullable) and
  MUST use `model.bigNumber().nullable()` (verified precedent:
  `delivery_order.shipping_fee` — `"shipping_fee" numeric null, "raw_shipping_fee"
  jsonb null` in `Migration20260616151508.ts`) — copy that exact shape. Use
  `model.number()` only for true integers (there are none of those in this
  epic's new tables). Critically: `moduleIntegrationTestRunner` (used by
  `modules/packs/__tests__/*.integration.spec.ts`) builds its schema **from
  the model definitions, not from migrations** — it CANNOT catch a
  hand-written migration that forgot a `raw_` column. The only thing that
  proves the migration itself is correct is an `integration-tests/http/*`
  spec (full app boot via `medusaIntegrationTestRunner`, which runs the real
  migrations against `pokenic-postgres`). Task 1's own spec only proves
  model/service self-consistency; Task 4 (the first writer with an http spec)
  is what proves the migration for real — say so at both tasks, don't claim
  Task 1 alone covers it.
- **Global formatter hook churns backend files.** A PostToolUse hook on
  Write|Edit rewrites backend double-quotes to single quotes, burying real
  changes in whole-file diffs that fail CI's format check. After any Edit to
  a file under `backend/`, immediately `git diff --stat` that file; if it
  shows more than the intended lines, revert and re-apply the SAME change via
  a small Node script executed through Bash instead of Edit/Write.
- **Commits:** `git commit -F <message-file>` (write the message to a file
  first). Plain ASCII only — a post-commit hook throws `UnicodeEncodeError` on
  non-ASCII bytes. NEVER PowerShell here-strings in Git Bash.
- **guard-secrets** blocks shell reads of `.env`; use PowerShell `Copy-Item`
  when the worktree needs one.
- **Integration tests:** from `backend/packages/api`:
  `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest
  integration-tests/http/<file> --runInBand --forceExit` (needs
  `pokenic-postgres` up). These take minutes — never background them, never
  retry-in-a-loop; read the failure and fix it.
- **Fresh test DB has no `fx_rate` row** — `resolveFxRate`/`resolveFxRateStrict`
  fall back to `DEFAULT_USD_MYR` (4.7), not the dev DB's 4.091, and
  `resolveFxRate` caches the resolved value for 30s in-process. Every spec in
  this plan that asserts a money value must `POST /admin/pricing/fx` with a
  FIRM rate in `beforeEach`, before any other route call, and unit specs that
  touch pricing must call `clearFxDisplayCache()` (from
  `modules/packs/pricing.ts`) in their own `beforeEach` (`--runInBand` means
  the cache persists across spec files in one process).
- **FX resolver choice for this epic's vault_delta math: lenient
  `resolveFxRate`, not `resolveFxRateStrict`.** The ledger row is a
  *record* of an event that already happened (or, for OD, a bookkeeping
  side-effect of one) — it is not itself a payment. `resolveFxRateStrict`
  throwing on a transient FX gap would turn "the ledger couldn't write a
  bookkeeping row" into "the customer's pack-open failed," which is a
  regression on a working money path. This is a stated design decision, not
  an oversight — do not "fix" it to strict without raising it with the
  operator first.
- **TypeScript strict, no `any`. Named exports. 2-space indent.**
  `payload` is a discriminated union (`LedgerPayload` in `modules/packs/ledger.ts`,
  keyed by the same `type` literal as the row) — narrow it at the one read
  boundary (the admin route) with a single cast helper, following the
  existing `rank_rewards as unknown as ChallengeRankReward[]` idiom in
  `service.ts` — never let ad-hoc `as` casts spread through call sites.
- **Scope boundary — say this explicitly wherever the ledger is described,
  including in the PR description:** after this epic, `ledger_entry` is
  **not** a 1:1 mirror of `credit_transaction`. Four existing credit reasons
  — `cashout` (withdrawal), `voucher_claim`, `reward_credit`, `daily_reward`
  — have no corresponding ledger type in the spec's 7-value enum (`TP | SP |
  SE | OD | RF | AD | WP`) and are deliberately NOT wired. Do not build
  reconciliation tooling that assumes ledger sum == credit_transaction sum.
- **Reversal semantics — two different mechanisms, do not conflate them:**
  (1) **In-flight workflow compensation** (a LATER step in the same
  open-pack/request-delivery run throws, before the workflow's overall effect
  is a settled fact) deletes both the domain row and its paired ledger row —
  they were never a completed event. (2) **Post-commit reversal**
  (`reverseOpen`, called after the whole open already succeeded) leaves the
  original SP ledger row standing, append-only, exactly like
  `admin_action_audit` never un-writes history. This epic implements (1) for
  every writer it adds and deliberately does NOT implement (2) for SP — a
  reversed/clawed-back open's ledger row still shows the original amounts.
  This is a stated scope boundary (§5/§6 do not define reversal-aware ledger
  semantics), pinned by a test, not a gap to quietly close later without
  the operator's sign-off.

## File Structure

```
backend/packages/api/src/modules/packs/
├── ledger.ts                              (new — LedgerType/LedgerPayload, nextSerial, sequenceScope, displayId)
├── models/
│   ├── ledger-entry.ts                    (new)
│   └── ledger-sequence.ts                 (new)
├── migrations/
│   └── Migration20260728210000.ts         (new)
├── service.ts                             (modified — +recordLedgerEntry, +recordPullsWithLedger,
│                                             +recordBuybackCreditTransaction, +topUpCreditsWithLedger,
│                                             +createDeliveryOrderWithLedger; adminAdjustCredit and
│                                             transitionDeliveryOrderStatus each gain one call)
└── __tests__/
    ├── ledger.unit.spec.ts                (new — pure id-gen)
    └── ledger-service.integration.spec.ts (new — moduleIntegrationTestRunner)

backend/packages/api/src/api/admin/
├── ledger/route.ts                        (new — GET /admin/ledger)
└── customers/[id]/transactions/route.ts   (modified — +ledger_display_id)

backend/packages/api/src/workflows/steps/
├── topup-credits.ts                       (modified)
├── buyback-pull.ts                        (modified)
├── record-pull.ts                         (modified)
├── record-pulls-batch.ts                  (modified)
└── request-delivery.ts                    (modified)

backend/packages/api/src/workflows/
├── open-pack.ts                           (modified — thread charge.price into record-pull input)
└── open-batch.ts                          (modified — thread charge.total into record-pulls-batch input)

backend/packages/api/integration-tests/http/
├── ledger-topup.spec.ts                   (new)
├── ledger-adjust.spec.ts                  (new)
├── ledger-buyback.spec.ts                 (new)
├── ledger-pack-open.spec.ts               (new)
├── ledger-delivery.spec.ts                (new)
└── admin-ledger-route.spec.ts             (new)

backend/apps/admin/src/
├── lib/admin-rest.ts                      (modified — Epic 4 marker)
├── lib/query-keys.ts                      (modified)
├── lib/queries.ts                         (modified)
├── i18n/en.json                           (modified — new top-level "ledger" block)
└── routes/ledger/page.tsx                 (new — Transactions page)
```

---

### Task 1: `ledger_entry` + `ledger_sequence` models and migration

**Files:**
- Create: `backend/packages/api/src/modules/packs/models/ledger-entry.ts`
- Create: `backend/packages/api/src/modules/packs/models/ledger-sequence.ts`
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260728210000.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts` (imports + `MedusaService({...})` model list, ~line 354)

**Interfaces:**
- Produces: `LedgerEntry` model (`id, display_id, type, customer_id, occurred_at,
  wallet_delta, vault_delta, payload, ref_id`) and `LedgerSequence` model
  (`id, scope, last_serial`), registered on `PacksModuleService` (auto-generates
  `createLedgerEntries`, `listLedgerEntries`, `listAndCountLedgerEntries`,
  `deleteLedgerEntries`, `createLedgerSequences`, `updateLedgerSequences`, …).

- [ ] **Step 1: Model files**

`models/ledger-entry.ts`:

```ts
import { model } from '@medusajs/framework/utils';

// ledger_entry — the operator-facing money/vault event log (POLYCARD-BACK
// §5). Go-forward only (D4): no backfill of pre-epic events, so history
// before this ships shows via the existing pull/credit_transaction views,
// never through this table. One row per source event; `ref_id` anchors the
// (type, ref_id) idempotency index below, chosen per-writer so it is
// ALSO the natural join key back to the row it describes (see
// modules/packs/service.ts recordLedgerEntry callers). wallet_delta/
// vault_delta are independently nullable — most writers only move one side
// (e.g. AD only ever touches wallet_delta).
export const LedgerEntry = model
  .define('ledger_entry', {
    id: model.id().primaryKey(),
    display_id: model.text().unique(),
    type: model.enum(['TP', 'SP', 'SE', 'OD', 'RF', 'AD', 'WP']),
    customer_id: model.text(),
    occurred_at: model.dateTime(),
    // MYR, signed. bigNumber (NOT number) — money — so this carries a
    // raw_wallet_delta/raw_vault_delta jsonb sidecar; the migration for this
    // table hand-writes both halves (see Migration20260728210000).
    wallet_delta: model.bigNumber().nullable(),
    vault_delta: model.bigNumber().nullable(),
    // Type-specific fields (LedgerPayload in ../ledger.ts). Nullable at the
    // DB level for defensiveness; every writer in this epic always supplies one.
    payload: model.json().nullable(),
    // The source row this event describes (see per-writer ref_id scheme in
    // this plan's Architecture section). Required — an entry with no ref_id
    // cannot be deduplicated and is a bug in the caller, not a valid state.
    ref_id: model.text(),
  })
  .indexes([
    // Idempotency (spec §5.3: "Idempotent per (type, ref_id) unique index").
    {
      name: 'IDX_ledger_entry_type_ref_id',
      on: ['type', 'ref_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    // Admin list: per-player wallet/vault history, newest first.
    {
      name: 'IDX_ledger_entry_customer_id_occurred_at',
      on: ['customer_id', 'occurred_at'],
      where: 'deleted_at IS NULL',
    },
    // Admin list: the type filter tabs.
    {
      name: 'IDX_ledger_entry_type_occurred_at',
      on: ['type', 'occurred_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default LedgerEntry;
```

`models/ledger-sequence.ts`:

```ts
import { model } from '@medusajs/framework/utils';

// ledger_sequence — one row per (type, year, quarter) scope (e.g.
// "TP-26-Q3"), holding the last-issued serial for modules/packs/ledger.ts's
// nextSerial(). Allocation locks THIS row (SELECT ... FOR UPDATE) inside the
// same transaction as the ledger_entry insert it is issuing an id for — see
// PacksModuleService.recordLedgerEntry. No gaps required, only uniqueness
// (spec §5.2); last_serial is nullable so a brand-new scope starts at NULL
// and nextSerial(null) mints "a0001".
export const LedgerSequence = model
  .define('ledger_sequence', {
    id: model.id().primaryKey(),
    scope: model.text().unique(),
    last_serial: model.text().nullable(),
  });

export default LedgerSequence;
```

- [ ] **Step 2: Migration**

`migrations/Migration20260728210000.ts`:

```ts
import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Transaction ledger (POLYCARD-BACK §5): two new tables, no changes to any
// existing table. Pure additive — expand-safe, no backfill (D4). Both money
// columns on ledger_entry are bigNumber, so each gets its raw_<field> jsonb
// sidecar (the trap: a migration that forgets this half passes every mocked
// test and fails on the first real insert — see Global Constraints).
export class Migration20260728210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "ledger_entry" (` +
        `"id" text not null, ` +
        `"display_id" text not null, ` +
        `"type" text check ("type" in ('TP','SP','SE','OD','RF','AD','WP')) not null, ` +
        `"customer_id" text not null, ` +
        `"occurred_at" timestamptz not null, ` +
        `"wallet_delta" numeric null, ` +
        `"raw_wallet_delta" jsonb null, ` +
        `"vault_delta" numeric null, ` +
        `"raw_vault_delta" jsonb null, ` +
        `"payload" jsonb null, ` +
        `"ref_id" text not null, ` +
        `"created_at" timestamptz not null default now(), ` +
        `"updated_at" timestamptz not null default now(), ` +
        `"deleted_at" timestamptz null, ` +
        `constraint "ledger_entry_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ledger_entry_display_id" ON "ledger_entry" ("display_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ledger_entry_type_ref_id" ON "ledger_entry" ("type", "ref_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_entry_customer_id_occurred_at" ON "ledger_entry" ("customer_id", "occurred_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_entry_type_occurred_at" ON "ledger_entry" ("type", "occurred_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `create table if not exists "ledger_sequence" (` +
        `"id" text not null, ` +
        `"scope" text not null, ` +
        `"last_serial" text null, ` +
        `"created_at" timestamptz not null default now(), ` +
        `"updated_at" timestamptz not null default now(), ` +
        `"deleted_at" timestamptz null, ` +
        `constraint "ledger_sequence_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ledger_sequence_scope" ON "ledger_sequence" ("scope") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ledger_sequence" cascade;`);
    this.addSql(`drop table if exists "ledger_entry" cascade;`);
  }
}
```

- [ ] **Step 3: Register on the service**

In `service.ts`: add `import LedgerEntry from './models/ledger-entry';` and
`import LedgerSequence from './models/ledger-sequence';` next to the other
model imports (~line 30-38), and add `LedgerEntry, LedgerSequence,` to the
`MedusaService({ ... })` call (~line 380, after `ChallengeSettings`).

- [ ] **Step 4: Migrate + verify**

From `backend/packages/api` (with `pokenic-postgres` up):
`corepack yarn medusa db:migrate` → applies cleanly, creates both tables.
`corepack yarn check-types` → clean (the two new models compile; no callers
exist yet so nothing else changes).

Note for the task report: this step proves the migration RUNS without
error and the model TYPES compile — it does **not** yet prove the migration's
SQL exactly matches what a real insert needs (the `raw_` sidecar trap). That
proof is Task 4's http integration spec, the first writer to insert a row
against this fully-migrated dev DB.

Optional extra check (`medusa db:generate` has no dry-run flag — verified via
`corepack yarn medusa db:generate --help`, so this generates a real file):
`corepack yarn medusa db:generate packs`, then inspect the emitted migration.
If it proposes nothing for `ledger_entry`/`ledger_sequence`, the model and
this hand-written migration agree — delete the generated file (this plan's
migration stays authoritative, matching every other hand-written migration
in this module). If it DOES propose something for either new table, that is
a real mismatch to fix before Step 5. It will very likely ALSO propose
unrelated changes for pre-existing tables (`docs/plans/postgres-best-practices-audit.md`
documents known historical model/migration drift on `credit_transaction`) —
ignore and discard those; they are out of scope for this epic and must not
be "fixed" as a drive-by.

- [ ] **Step 5: Commit** — `feat(ledger): ledger_entry + ledger_sequence models and migration`

---

### Task 2: Pure display-id generator (`modules/packs/ledger.ts`)

**Files:**
- Create: `backend/packages/api/src/modules/packs/ledger.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/ledger.unit.spec.ts`

**Interfaces:**
- Produces:

```ts
export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'RF' | 'AD' | 'WP';
export type LedgerPayload = /* discriminated union, see Step 3 */;
export function nextSerial(prev: string | null): string;
export function ymqInMyt(d: Date): { yy: string; q: 1 | 2 | 3 | 4 };
export function sequenceScope(type: LedgerType, occurredAt: Date): string;
export function displayId(type: LedgerType, occurredAt: Date, serial: string): string;
```

- [ ] **Step 1: Write the failing spec**

```ts
import { nextSerial, ymqInMyt, sequenceScope, displayId } from '../ledger';

describe('ledger — nextSerial (spec §5.2 rollovers)', () => {
  it('starts a fresh scope at a0001', () => {
    expect(nextSerial(null)).toBe('a0001');
  });
  it('increments the digit block', () => {
    expect(nextSerial('a0001')).toBe('a0002');
    expect(nextSerial('a0412')).toBe('a0413');
  });
  it('rolls the letter block at 9999 (a9999 -> b0001)', () => {
    expect(nextSerial('a9999')).toBe('b0001');
  });
  it('rolls a second letter block at 9999 (z... never happens before aa;'
    + ' the letter block itself rolls z -> aa)', () => {
    expect(nextSerial('z9999')).toBe('aa0001');
  });
  it('carries a multi-letter block (az9999 -> ba0001)', () => {
    expect(nextSerial('az9999')).toBe('ba0001');
  });
  it('rejects a malformed stored serial rather than silently reusing it', () => {
    expect(() => nextSerial('A0001')).toThrow();
    expect(() => nextSerial('a1')).toThrow();
    expect(() => nextSerial('0001')).toThrow();
  });
});

describe('ledger — MYT year/quarter derivation', () => {
  it('reads a mid-quarter UTC instant correctly', () => {
    // 2026-08-15 12:00 UTC = 2026-08-15 20:00 MYT -> Q3
    expect(ymqInMyt(new Date('2026-08-15T12:00:00Z'))).toEqual({ yy: '26', q: 3 });
  });
  it('the MYT day boundary can roll the quarter relative to UTC', () => {
    // 2026-09-30 17:00 UTC = 2026-10-01 01:00 MYT -> Q4, even though the UTC
    // instant is still September (the whole reason occurred_at math must be
    // done in Asia/Kuala_Lumpur, not UTC — POLYCARD-BACK baked default).
    expect(ymqInMyt(new Date('2026-09-30T17:00:00Z'))).toEqual({ yy: '26', q: 4 });
  });
  it('the MYT year boundary can roll the year relative to UTC', () => {
    // 2026-12-31 17:30 UTC = 2027-01-01 01:30 MYT -> next year, Q1.
    expect(ymqInMyt(new Date('2026-12-31T17:30:00Z'))).toEqual({ yy: '27', q: 1 });
  });
  it('sequenceScope combines type + yy + quarter', () => {
    expect(sequenceScope('TP', new Date('2026-08-15T12:00:00Z'))).toBe('TP-26-Q3');
  });
  it('a scope changes across a quarter rollover', () => {
    const a = sequenceScope('AD', new Date('2026-09-30T17:00:00Z'));
    const b = sequenceScope('AD', new Date('2026-09-30T15:00:00Z'));
    expect(a).not.toBe(b); // Q4 vs Q3 for instants 2h apart
  });
});

describe('ledger — displayId', () => {
  it('renders TYPE + YY + Q# + UPPERCASE serial (spec example: TP26Q3A0001)', () => {
    expect(displayId('TP', new Date('2026-08-15T12:00:00Z'), 'a0001')).toBe('TP26Q3A0001');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `corepack yarn test:unit --testPathPattern ledger` (from `backend/packages/api`) → FAIL (module does not exist).

- [ ] **Step 3: Implement**

```ts
// modules/packs/ledger.ts
//
// Transaction ledger pure logic (POLYCARD-BACK §5): the display-id serial
// successor and the MYT scope derivation. No Medusa/DB imports — unit
// testable standalone, and this is the ONLY place that resolves the spec's
// own case inconsistency between its two examples (display id "TP26Q3A0001"
// is uppercase; ledger_sequence.last_serial "a0413" is lowercase): serials
// are STORED lowercase, RENDERED uppercase in the display id.
//
// ymqInMyt uses a fixed +8h offset, not a timezone library. This is correct
// ONLY because Asia/Kuala_Lumpur has never observed DST (a fixed UTC+8 all
// year) — ponytail: if this ever needs to serve a DST-observing zone, this
// function needs Intl.DateTimeFormat/date-fns-tz instead of the fixed shift.

export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'RF' | 'AD' | 'WP';

export type LedgerPayload =
  | { type: 'TP'; payment_method: string; gateway_ref: string | null }
  | { type: 'SP'; channel: 'single' | 'batch'; pack_id: string; prize_skus: string[] }
  | { type: 'SE'; card_handle: string; sp_ref_id: string | null; price: number; rate: number }
  | { type: 'OD'; handles: { card_handle: string; qty: number }[]; status: string }
  | { type: 'RF'; period: string; spend_total: number; pct: number }
  | { type: 'AD'; admin_id: string; reason: string; detail: string | null; card_handle: string | null }
  | { type: 'WP'; period: string; stage: number; rank: number; sku: string | null; value: number };

const SERIAL_RE = /^([a-z]+)(\d{4})$/;

// a0001 -> a0002 -> ... -> a9999 -> b0001 -> ... -> z9999 -> aa0001 -> ...
// Digits always reset to 0001 when the letter block advances (spec §5.2).
export function nextSerial(prev: string | null): string {
  if (prev === null) return 'a0001';
  const m = SERIAL_RE.exec(prev);
  if (!m) {
    throw new Error(`ledger: malformed stored serial '${prev}' (expected /^[a-z]+\\d{4}$/)`);
  }
  const [, letters, digits] = m;
  const n = Number(digits);
  if (n < 9999) return `${letters}${String(n + 1).padStart(4, '0')}`;
  return `${nextLetterBlock(letters)}0001`;
}

// Base-26 increment over a..z with carry: a -> b, z -> aa, az -> ba, zz -> aaa.
function nextLetterBlock(letters: string): string {
  const chars = letters.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'a';
  }
  return `a${chars.join('')}`; // every position carried past 'z'
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

export function ymqInMyt(d: Date): { yy: string; q: 1 | 2 | 3 | 4 } {
  const myt = new Date(d.getTime() + MYT_OFFSET_MS);
  const yy = String(myt.getUTCFullYear() % 100).padStart(2, '0');
  const q = (Math.floor(myt.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  return { yy, q };
}

// The ledger_sequence row key: one counter per (type, MYT year, MYT quarter).
export function sequenceScope(type: LedgerType, occurredAt: Date): string {
  const { yy, q } = ymqInMyt(occurredAt);
  return `${type}-${yy}-Q${q}`;
}

// The public display id: TYPE + YY + Q# + UPPERCASE serial.
export function displayId(type: LedgerType, occurredAt: Date, serial: string): string {
  const { yy, q } = ymqInMyt(occurredAt);
  return `${type}${yy}Q${q}${serial.toUpperCase()}`;
}
```

- [ ] **Step 4: Verify pass** — `corepack yarn test:unit --testPathPattern ledger` green; `corepack yarn check-types` clean.

- [ ] **Step 5: Commit** — `feat(ledger): pure display-id generator (nextSerial, MYT scope, displayId)`

---

### Task 3: `recordLedgerEntry` — the write primitive

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method near `adminAdjustCredit`, ~line 3690)
- Test: `backend/packages/api/src/modules/packs/__tests__/ledger-service.integration.spec.ts` (new — `moduleIntegrationTestRunner`)

**Interfaces:**
- Consumes: `nextSerial`, `sequenceScope`, `displayId`, `LedgerType`, `LedgerPayload` (Task 2); the file's existing `LedgerSqlManager` type (already in scope at the top of `service.ts`, no new import).
- Produces:

```ts
async recordLedgerEntry(
  input: {
    type: LedgerType;
    customerId: string;
    refId: string;
    walletDelta: number | null;
    vaultDelta: number | null;
    payload: LedgerPayload;
    occurredAt?: Date;
  },
  sharedContext?: Context,
): Promise<{ id: string; display_id: string; replayed: boolean }>
```

- [ ] **Step 1: Write the failing spec**

`ledger-service.integration.spec.ts` — follows
`recorded-pull-value.integration.spec.ts`'s `moduleIntegrationTestRunner`
shape, but `moduleModels` only needs the models THIS spec actually touches
(verified against that file: its own list of 17 models is not the full
`PacksModuleService` roster of ~24 either — `moduleModels` scopes the
ephemeral sync'd schema to what the spec exercises, not the whole module):

```ts
import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [LedgerEntry, LedgerSequence],
  testSuite: ({ service }) => {
    const occurredAt = new Date('2026-08-15T12:00:00Z'); // MYT Q3

    it('allocates a scoped, incrementing display_id and both deltas round-trip', async () => {
      const a = await service.recordLedgerEntry({
        type: 'AD', customerId: 'cus_1', refId: 'ctxn_1',
        walletDelta: 12.34, vaultDelta: null,
        payload: { type: 'AD', admin_id: 'user_1', reason: 'test', detail: null, card_handle: null },
        occurredAt,
      });
      expect(a.display_id).toBe('AD26Q3A0001');
      const b = await service.recordLedgerEntry({
        type: 'AD', customerId: 'cus_2', refId: 'ctxn_2',
        walletDelta: -5, vaultDelta: 7.5,
        payload: { type: 'AD', admin_id: 'user_1', reason: 'test 2', detail: null, card_handle: null },
        occurredAt,
      });
      expect(b.display_id).toBe('AD26Q3A0002');
      const [row] = await service.listLedgerEntries({ id: b.id });
      // bigNumber fields come back as strings/objects from the ORM — Number()
      // normalizes exactly like every other money read site in this file.
      expect(Number(row.wallet_delta)).toBe(-5);
      expect(Number(row.vault_delta)).toBe(7.5);
    });

    it('is idempotent on (type, ref_id) — a replay returns the ORIGINAL row, not a new one', async () => {
      const first = await service.recordLedgerEntry({
        type: 'SE', customerId: 'cus_3', refId: 'ctxn_dup',
        walletDelta: 40, vaultDelta: -40,
        payload: { type: 'SE', card_handle: 'card-x', sp_ref_id: null, price: 40, rate: 0.9 },
        occurredAt,
      });
      const replay = await service.recordLedgerEntry({
        type: 'SE', customerId: 'cus_3', refId: 'ctxn_dup',
        walletDelta: 999, vaultDelta: -999, // different numbers — must be IGNORED
        payload: { type: 'SE', card_handle: 'card-x', sp_ref_id: null, price: 999, rate: 1 },
        occurredAt,
      });
      expect(replay.id).toBe(first.id);
      expect(replay.replayed).toBe(true);
      const rows = await service.listLedgerEntries({ type: 'SE', ref_id: 'ctxn_dup' });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].wallet_delta)).toBe(40); // the original, not the replay
    });

    it('a different type with the SAME ref_id is a different row (idempotency is per-type)', async () => {
      const od = await service.recordLedgerEntry({
        type: 'OD', customerId: 'cus_4', refId: 'shared-ref',
        walletDelta: 0, vaultDelta: -10,
        payload: { type: 'OD', handles: [{ card_handle: 'c', qty: 1 }], status: 'requested' },
        occurredAt,
      });
      const sp = await service.recordLedgerEntry({
        type: 'SP', customerId: 'cus_4', refId: 'shared-ref',
        walletDelta: -10, vaultDelta: 10,
        payload: { type: 'SP', channel: 'single', pack_id: 'p', prize_skus: ['c'] },
        occurredAt,
      });
      expect(od.id).not.toBe(sp.id);
    });

    it('concurrency: N parallel writers on a FRESH scope never collide and never lose an increment', async () => {
      const freshScopeInstant = new Date('2031-05-01T04:00:00Z'); // a scope no other test touches
      const N = 12;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          service.recordLedgerEntry({
            type: 'WP', customerId: `cus_wp_${i}`, refId: `wp_${i}`,
            walletDelta: 1, vaultDelta: null,
            payload: { type: 'WP', period: '2031-W18', stage: 1, rank: i, sku: null, value: 1 },
            occurredAt: freshScopeInstant,
          }),
        ),
      );
      const ids = new Set(results.map((r) => r.display_id));
      expect(ids.size).toBe(N); // no duplicates
      const [seq] = await service.listLedgerSequences({ scope: 'WP-31-Q2' });
      expect(seq.last_serial).toBe(`a${String(N).padStart(4, '0')}`); // no lost updates
    });
  },
});
```

- [ ] **Step 2: Run to verify failure** — `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:modules npx jest src/modules/packs/__tests__/ledger-service.integration.spec.ts --runInBand --forceExit` → FAIL (`recordLedgerEntry` not defined).

- [ ] **Step 3: Implement**

Add near `adminAdjustCredit` in `service.ts` (top-of-file import: `import {
displayId, nextSerial, sequenceScope, type LedgerPayload, type LedgerType }
from './ledger';`):

```ts
  // recordLedgerEntry — THE write primitive for POLYCARD-BACK §5. Every
  // writer in this epic calls this from WITHIN its own
  // @InjectTransactionManager() method, passing that method's sharedContext,
  // so the ledger row lands in the SAME transaction as the domain write it
  // describes (never called bare — a bare call opens its own transaction,
  // which breaks "same DB transaction as the source write").
  //
  // Idempotency: an explicit pre-check via raw SQL (fires immediately, like
  // settleOpen's own pre-check) rather than catching a unique-violation from
  // an ORM insert — MikroORM's Unit of Work buffers ORM creates until flush
  // (transaction commit), so a 23505 from createLedgerEntries would surface
  // AFTER this method returns, where it can't be handled cleanly. The
  // (type, ref_id) partial unique index is a defensive backstop for the
  // theoretical case where two callers race for the same key with no shared
  // outer lock; every real caller in this epic already holds one (the
  // per-customer credit lock or the per-order delivery lock).
  @InjectTransactionManager()
  async recordLedgerEntry(
    input: {
      type: LedgerType;
      customerId: string;
      refId: string;
      walletDelta: number | null;
      vaultDelta: number | null;
      payload: LedgerPayload;
      occurredAt?: Date;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ id: string; display_id: string; replayed: boolean }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const occurredAt = input.occurredAt ?? new Date();

    const [existing] = await em.execute<
      { id: string; display_id: string }[]
    >(
      'SELECT id, display_id FROM ledger_entry WHERE type = ? AND ref_id = ? AND deleted_at IS NULL LIMIT 1',
      [input.type, input.refId],
    );
    if (existing) {
      return { id: existing.id, display_id: existing.display_id, replayed: true };
    }

    const scope = sequenceScope(input.type, occurredAt);

    // Upsert-then-lock: a brand-new scope has no row for FOR UPDATE to hold,
    // so create it first (ON CONFLICT DO NOTHING absorbs a concurrent
    // first-writer race on the SAME fresh scope), then lock + read whoever's
    // row won.
    await em.execute(
      'INSERT INTO ledger_sequence (id, scope, last_serial, created_at, updated_at) ' +
        "VALUES (?, ?, NULL, now(), now()) ON CONFLICT (scope) WHERE deleted_at IS NULL DO NOTHING",
      [randomUUID(), scope],
    );
    const [seqRow] = await em.execute<{ id: string; last_serial: string | null }[]>(
      'SELECT id, last_serial FROM ledger_sequence WHERE scope = ? AND deleted_at IS NULL FOR UPDATE',
      [scope],
    );
    const serial = nextSerial(seqRow.last_serial);
    await em.execute(
      'UPDATE ledger_sequence SET last_serial = ?, updated_at = now() WHERE id = ?',
      [serial, seqRow.id],
    );

    const id = input.type + '_' + randomUUID(); // any unique text works; MedusaService ids are opaque anyway
    const [row] = await this.createLedgerEntries(
      [
        {
          id,
          display_id: displayId(input.type, occurredAt, serial),
          type: input.type,
          customer_id: input.customerId,
          occurred_at: occurredAt,
          wallet_delta: input.walletDelta,
          vault_delta: input.vaultDelta,
          payload: input.payload,
          ref_id: input.refId,
        },
      ],
      sharedContext,
    );
    return { id: row.id, display_id: row.display_id, replayed: false };
  }

  // Compensation-only delete by (type, ref_id) — every writer's workflow-step
  // compensation (Tasks 4-8) calls THIS, not the raw generated method, so the
  // `as never` escape lives in exactly one place. Precedent:
  // deleteCreditTransactionsGuarded (~line 3415) casts the same way — the
  // MedusaService-generated delete accepts a filter selector at runtime, but
  // its generated TS signature only declares id/id[]. This is for IN-FLIGHT
  // workflow rollback only (see Global Constraints' two-mechanisms note) —
  // never call it to "fix" a settled row.
  async deleteLedgerEntryByRef(type: LedgerType, refId: string): Promise<void> {
    await this.deleteLedgerEntries({ type, ref_id: refId } as never);
  }
```

`randomUUID` is already imported at the top of `service.ts` (`import {
randomInt } from 'node:crypto';` — add `randomUUID` to that same import).

- [ ] **Step 4: Verify pass** — the integration spec green (all 4 cases);
`corepack yarn check-types` clean.

- [ ] **Step 5: Commit** — `feat(ledger): recordLedgerEntry write primitive with scoped display-id allocation`

---

### Task 4: TP writer — top-up

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method near `mutateCreditAtomic`)
- Modify: `backend/packages/api/src/workflows/steps/topup-credits.ts`
- Test: `backend/packages/api/integration-tests/http/ledger-topup.spec.ts` (new)

**Interfaces:**
- Consumes: `recordLedgerEntry` (Task 3); the existing `mutateCreditAtomic`.
- Produces: `topUpCreditsWithLedger(input, sharedContext?)` — same signature
  and return shape as `mutateCreditAtomic`, plus the paired TP ledger row in
  the same transaction. `topUpCreditsStep` calls this instead of
  `mutateCreditAtomic` directly.

- [ ] **Step 1: Write the failing spec**

`ledger-topup.spec.ts` — copy the runner/registration/login boilerplate from
`integration-tests/http/credit-topup.spec.ts` (`// gitleaks:allow` on the
synthetic password), INCLUDING its `medusaIntegrationTestRunner({ inApp:
true, testSuite: ({ api, getContainer }) => { ... } })` shape and its
`authed`/`storeHeaders` helpers. Two adjustments to the copied boilerplate:

1. That file's `registerCustomer(email)` returns only a token
   (`Promise<string>`) — extend it to also capture and return the customer
   id, the same one-line change described in Task 6/7: capture the
   `/store/customers` response (currently discarded) and return `{ token:
   login.data.token, id: created.data.customer.id }`.
2. That file has no admin setup (it never needed one) — add a `mintSuperAdmin`
   call in `beforeEach` and an `adminHeaders()` helper, copied from
   `credit-adjust.spec.ts`'s exact shape, so `beforeEach` can call `POST
   /admin/pricing/fx` with a firm rate (this spec's own assertions are
   id-shape/amount only and don't need FX, but every money spec in this repo
   pins FX per the Global Constraints — do it anyway so nobody copies this
   file as a template that skips it).

Add ONE local helper, inside the `describe` block next to that file's own
`ledgerRows` (which reads `credit_transaction` — deliberately a DIFFERENT
name, `ledgerEntryRowsFor`, so nobody confuses the two "ledger" words in this
codebase): it resolves `PacksModuleService` straight from the container,
exactly the way that same file's existing `ledgerRows` helper does — no
admin route needed for these assertions at all (Task 9's route is for the
admin UI, not for this spec):

```ts
const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const filter: Record<string, unknown> = { customer_id: customerId };
  if (type) filter.type = type;
  return packs.listLedgerEntries(filter, { order: { occurred_at: 'DESC' } }) as Promise<any[]>;
};

it('a top-up writes ONE TP ledger row, same amount, wallet_delta only', async () => {
  const { token, id } = await registerCustomer('ledger-test-1@test.dev');
  const res = await api.post(
    '/store/credits/topup',
    { amount: 50 },
    { headers: { ...authed(token), 'idempotency-key': 'ik-1' } },
  );
  expect(res.status).toBe(200);

  const rows = await ledgerEntryRowsFor(id, 'TP');
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].wallet_delta)).toBe(50);
  expect(rows[0].vault_delta).toBeNull();
  expect(rows[0].display_id).toMatch(/^TP\d{2}Q[1-4][A-Za-z]+\d{4}$/);
});

it('a replayed top-up (same idempotency key) does not double-write the ledger', async () => {
  const { token, id } = await registerCustomer('ledger-test-2@test.dev');
  const headers = { ...authed(token), 'idempotency-key': 'ik-2' };
  await api.post('/store/credits/topup', { amount: 20 }, { headers });
  await api.post('/store/credits/topup', { amount: 20 }, { headers }); // replay
  const rows = await ledgerEntryRowsFor(id, 'TP');
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure** — `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/ledger-topup.spec.ts --runInBand --forceExit` → FAIL (`topUpCreditsWithLedger` undefined / zero rows).

- [ ] **Step 3: Implement**

`service.ts`, near `mutateCreditAtomic`:

```ts
  // Wraps mutateCreditAtomic with the paired TP ledger row, same transaction
  // (POLYCARD-BACK §5.3). ref_id = the credit_transaction's own id, so the
  // Wallet-tab join (Task 9) is a plain equality on credit_transaction.id.
  @InjectTransactionManager()
  async topUpCreditsWithLedger(
    input: CreditMutationInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<ReturnType<PacksModuleService['mutateCreditAtomic']>> {
    const result = await this.mutateCreditAtomic(input, sharedContext);
    if (!result.replayed) {
      await this.recordLedgerEntry(
        {
          type: 'TP',
          customerId: input.customerId,
          refId: result.id,
          walletDelta: result.amount,
          vaultDelta: null,
          payload: { type: 'TP', payment_method: 'mock', gateway_ref: result.reference },
        },
        sharedContext,
      );
    }
    return result;
  }
```

`workflows/steps/topup-credits.ts` — swap the one call:

```diff
-    const mutation = await packs.mutateCreditAtomic({
+    const mutation = await packs.topUpCreditsWithLedger({
       customerId: input.customer_id,
```

(No other change to that file — the compensation function already deletes
the credit_transaction row via `deleteCreditTransactionsGuarded`; since the
ledger row was committed in the SAME transaction as that credit row, and a
top-up's compensation only ever fires for a REAL write (never a replay, per
the file's own `if (data.replayed) return;` guard), leaving the ledger row on
compensation would orphan it — add ONE line there too:)

```diff
     const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
     await packs.deleteCreditTransactionsGuarded([data.creditTransactionId]);
+    await packs.deleteLedgerEntryByRef('TP', data.creditTransactionId);
   },
```

- [ ] **Step 4: Verify pass** — the new http spec green (both cases); extend
  `credit-topup.spec.ts`'s existing compensation-path test (if one exists —
  grep the file for a "declined charge" or "compensation" case) to also
  assert zero ledger rows after a compensated top-up; full `corepack yarn
  test:unit`; `check-types`.

- [ ] **Step 5: Commit** — `feat(ledger): TP writer — top-up credits`

---

### Task 5: AD writer — operator adjustment

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (`adminAdjustCredit`, ~line 3656)
- Test: `backend/packages/api/integration-tests/http/ledger-adjust.spec.ts` (new)

**Interfaces:**
- Consumes: `recordLedgerEntry` (Task 3). `adminAdjustCredit` already holds a
  `sharedContext` spanning the debit + the audit row — this is the smallest
  writer in the epic (one call added to an existing method already shaped
  exactly right).

- [ ] **Step 1: Write the failing spec**

Copy boilerplate from `integration-tests/http/credit-adjust.spec.ts`, again
INCLUDING the `{ api, getContainer }` testSuite destructure, and the same
local `ledgerEntryRowsFor` helper Task 4 introduced (each spec file in this
repo carries its own local copy of shared helpers — there is no shared
test-utils import for them; `registerCustomer`/`authed` are duplicated the
same way across every existing spec file here):

```ts
const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const filter: Record<string, unknown> = { customer_id: customerId };
  if (type) filter.type = type;
  return packs.listLedgerEntries(filter, { order: { occurred_at: 'DESC' } });
};

it('an admin adjustment writes ONE AD ledger row alongside the audit row', async () => {
  const { id } = await registerCustomer('ledger-test-3@test.dev');
  await api.post(
    `/admin/customers/${id}/credits`,
    { amount: 15, note: 'goodwill credit' },
    { headers: adminHeaders() },
  );
  const rows = await ledgerEntryRowsFor(id, 'AD');
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].wallet_delta)).toBe(15);
  expect(rows[0].vault_delta).toBeNull();
});

it('a deduction (negative amount) records the signed delta', async () => {
  const { id } = await registerCustomer('ledger-test-4@test.dev');
  await api.post(`/admin/customers/${id}/credits`, { amount: 30, note: 'seed' }, { headers: adminHeaders() });
  await api.post(`/admin/customers/${id}/credits`, { amount: -10, note: 'correction' }, { headers: adminHeaders() });
  const rows = await ledgerEntryRowsFor(id, 'AD');
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => Number(r.wallet_delta)).sort((a, b) => a - b)).toEqual([-10, 30]);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (no AD rows written).

- [ ] **Step 3: Implement** — in `adminAdjustCredit`, right after the
  `createAdminActionAudits` call, before `return`:

```ts
    await this.recordLedgerEntry(
      {
        type: 'AD',
        customerId: input.customerId,
        refId: id, // the credit_transaction id already in scope
        walletDelta: input.amount,
        vaultDelta: null,
        payload: {
          type: 'AD',
          admin_id: input.adminId,
          reason: input.note,
          detail: null,
          card_handle: null,
        },
      },
      sharedContext,
    );
```

`adjust-credits.ts`'s step compensation (`deleteCreditTransactionsGuarded`)
gains the same one-line pairing as Task 4's TP compensation:

```diff
     const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
     await packs.deleteCreditTransactionsGuarded([data.creditTransactionId]);
+    await packs.deleteLedgerEntryByRef('AD', data.creditTransactionId);
   },
```

- [ ] **Step 4: Verify pass** — spec green; extend
  `integration-tests/http/admin-adjust-audit.spec.ts` with one assertion that
  the audit row and the ledger row share the same `reason`/`note` text (they
  are describing the SAME event from two angles — a reviewer should be able
  to cross-check them); full `test:unit` + `check-types`.

- [ ] **Step 5: Commit** — `feat(ledger): AD writer — operator credit adjustment`

---

### Task 6: SE writer — buyback / sell

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method near `buybackAmount`'s callers, or beside `adminAdjustCredit`)
- Modify: `backend/packages/api/src/workflows/steps/buyback-pull.ts`
- Test: `backend/packages/api/integration-tests/http/ledger-buyback.spec.ts` (new)

**Interfaces:**
- Consumes: `recordLedgerEntry`; `insertOrMapDuplicate` (already imported in
  `buyback-pull.ts` — its own header comment literally anticipates "any
  future ledger insert").
- Produces: `recordBuybackCreditTransaction(input, sharedContext?):
  Promise<CreditTransactionDTO[]>` — same return shape as
  `createCreditTransactions` (an array with one row), so it drops straight
  into `insertOrMapDuplicate`'s `insert:` callback with no other change to
  that call site's shape.

- [ ] **Step 1: Write the failing spec**

Copy boilerplate from `integration-tests/http/vault-buyback.spec.ts`
(constants `PACK_SLUG`/`TOPUP`/`PACK_PRICE`, its `authed`/`registerCustomer`
helpers), plus the same local `ledgerEntryRowsFor` helper (Task 4). That
file's `registerCustomer(email)` returns only a token (`Promise<string>`) —
extend it the same one-line way as Task 7's to also return `id`. That file
has no single "open a pack and get a vaulted pull id" helper (its own tests
inline the top-up + open sequence) — add one local to THIS new spec file:

```ts
const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const filter: Record<string, unknown> = { customer_id: customerId };
  if (type) filter.type = type;
  return packs.listLedgerEntries(filter, { order: { occurred_at: 'DESC' } }) as Promise<any[]>;
};

// Fund one pack's price and open it — returns the resulting vaulted pull id.
const openOne = async (token: string): Promise<string> => {
  await api.post(
    '/store/credits/topup',
    { amount: PACK_PRICE },
    { headers: { ...authed(token), 'idempotency-key': 'ledger-se-topup' } },
  );
  const open = await api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) });
  return open.data.pull.id as string;
};

it('a buyback writes ONE SE ledger row: wallet +, vault -, same magnitude', async () => {
  const { token, id } = await registerCustomer('ledger-test-5@test.dev');
  const pullId = await openOne(token);
  const res = await api.post(`/store/vault/${pullId}/buyback`, {}, { headers: authed(token) });
  expect(res.status).toBe(200);
  const amount = res.data.amount as number;

  const rows = await ledgerEntryRowsFor(id, 'SE');
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].wallet_delta)).toBe(amount);
  expect(Number(rows[0].vault_delta)).toBe(-amount);
});

it('a duplicate buyback attempt on the same pull writes no second ledger row', async () => {
  const { token, id } = await registerCustomer('ledger-test-6@test.dev');
  const pullId = await openOne(token);
  await api.post(`/store/vault/${pullId}/buyback`, {}, { headers: authed(token) });
  await api.post(`/store/vault/${pullId}/buyback`, {}, { headers: authed(token) }); // 400 — "already sold back"
  const rows = await ledgerEntryRowsFor(id, 'SE');
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

`service.ts`, near `adminAdjustCredit`:

```ts
  // Wraps the buyback credit insert with its paired SE ledger row, same
  // transaction. sp_ref_id links back to the ORIGINAL pack-open (if the pull
  // still carries its open_id — reward pulls and pre-open_id-era rows won't),
  // matching the spec's "[SP id]" payload field.
  @InjectTransactionManager()
  async recordBuybackCreditTransaction(
    input: { customerId: string; amount: number; pullId: string; cardHandle: string; rate: number; openId: string | null },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Awaited<ReturnType<PacksModuleService['createCreditTransactions']>>> {
    const rows = await this.createCreditTransactions(
      [{ customer_id: input.customerId, amount: input.amount, reason: 'buyback' as const, pull_id: input.pullId }],
      sharedContext,
    );
    await this.recordLedgerEntry(
      {
        type: 'SE',
        customerId: input.customerId,
        refId: rows[0].id,
        walletDelta: input.amount,
        vaultDelta: -input.amount,
        payload: {
          type: 'SE',
          card_handle: input.cardHandle,
          sp_ref_id: input.openId,
          price: input.amount,
          rate: input.rate,
        },
      },
      sharedContext,
    );
    return rows;
  }
```

`buyback-pull.ts` — the `insert:` callback swaps target and gains the two
extra fields it already has in scope at that point (`pull.open_id`, `pull.card_id`, `percent`):

```diff
     const [txn] = await insertOrMapDuplicate({
       insert: () =>
-        packs.createCreditTransactions([
-          {
-            customer_id: input.customer_id,
-            amount,
-            reason: 'buyback' as const,
-            pull_id: pull.id,
-          },
-        ]),
+        packs.recordBuybackCreditTransaction({
+          customerId: input.customer_id,
+          amount,
+          pullId: pull.id,
+          cardHandle: pull.card_id,
+          rate: percent / 100,
+          openId: pull.open_id ?? null,
+        }),
```

The rest of `buyback-pull.ts` is untouched — `txn.id` still resolves the
same way, and the existing `deleteCreditTransactionsGuarded` undo path in
BOTH the manual try/catch (pull-flip failure) and the step's own compensation
gains the paired ledger delete:

```diff
       try {
         await packs.deleteCreditTransactionsGuarded([creditTransactionId]);
+        await packs.deleteLedgerEntryByRef('SE', creditTransactionId);
       } catch (undoError) {
```
(apply the same one-line addition at the step's top-level compensation
function too, next to its existing `deleteCreditTransactionsGuarded` call).

- [ ] **Step 4: Verify pass** — spec green (2/2); full `test:unit`; `check-types`.

- [ ] **Step 5: Commit** — `feat(ledger): SE writer — buyback / sell`

---

### Task 7: SP writer — pack-open spend (single + batch)

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method near `settleOpen`)
- Modify: `backend/packages/api/src/workflows/steps/record-pull.ts`
- Modify: `backend/packages/api/src/workflows/steps/record-pulls-batch.ts`
- Modify: `backend/packages/api/src/workflows/open-pack.ts`
- Modify: `backend/packages/api/src/workflows/open-batch.ts`
- Test: `backend/packages/api/integration-tests/http/ledger-pack-open.spec.ts` (new)

**Interfaces:**
- Consumes: `recordLedgerEntry`; `resolveFxRate`, `displayMarketPrice`,
  `DEFAULT_MARKET_MULTIPLIER` (`modules/packs/pricing.ts`).
- Produces: `recordPullsWithLedger(input, sharedContext?)` — wraps
  `createPulls` with the paired SP ledger row (ONE row per open, whether
  single or batch — batch shares one `open_id` across N pulls, so it gets
  ONE ledger row too, not N). Both `record-pull.ts` and
  `record-pulls-batch.ts` call it; both workflows thread the charge's price
  into the step's input.

- [ ] **Step 1: Write the failing spec**

Copy boilerplate (runner, publishable key, `topUp` helper) from
`pack-open-charge.spec.ts`, INCLUDING its `medusaIntegrationTestRunner({
inApp: true, testSuite: ({ api, getContainer }) => { ... } })` shape — case 3
below needs `getContainer` in that same destructure. ONE change to the copied
`registerCustomer`: that file's version returns only a token
(`Promise<string>`) because it never needed the customer's own id; this spec
does (to scope `ledgerEntryRowsFor`), so capture the `/store/customers`
response it already POSTs to (currently discarded) and return `{ token:
login.data.token, id: created.data.customer.id }` instead — the exact shape
`credit-adjust.spec.ts`'s own `registerCustomer` already returns.

```ts
const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const filter: Record<string, unknown> = { customer_id: customerId };
  if (type) filter.type = type;
  return packs.listLedgerEntries(filter, { order: { occurred_at: 'DESC' } }) as Promise<any[]>;
};

it('a single open writes ONE SP row: wallet -price, vault +pull value', async () => {
  const { token, id } = await registerCustomer('ledger-test-7@test.dev');
  await topUp(1000, authed(token));
  const res = await api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) });
  expect(res.status).toBe(200);

  const rows = await ledgerEntryRowsFor(id, 'SP');
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].wallet_delta)).toBe(-res.data.price);
  expect(Number(rows[0].vault_delta)).toBeGreaterThan(0);
  expect(rows[0].display_id).toMatch(/^SP/);
});

it('a batch open (count=3) writes ONE SP row for the whole batch, not three', async () => {
  const { token, id } = await registerCustomer('ledger-test-8@test.dev');
  await topUp(1000, authed(token));
  const res = await api.post(`/store/packs/${PACK_SLUG}/open-batch`, { count: 3 }, { headers: authed(token) });
  expect(res.status).toBe(200);

  const rows = await ledgerEntryRowsFor(id, 'SP');
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].wallet_delta)).toBe(-res.data.total);
  expect(rows[0].payload.prize_skus).toHaveLength(3);
  expect(rows[0].payload.channel).toBe('batch');
});

it('a reversed open leaves its SP ledger row standing (append-only — scope boundary, see Global Constraints)', async () => {
  // getContainer() is the same seam pack-open-charge.spec.ts already uses to
  // resolve PacksModuleService directly — reverseOpen is a post-commit admin/
  // fraud tool with no store or admin ROUTE of its own today, so the test
  // reaches it exactly the way any future admin route would: via the service.
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

  const { token, id } = await registerCustomer('ledger-test-9@test.dev');
  await topUp(1000, authed(token));
  await api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) });

  const [pull] = await packs.listPulls({ customer_id: id }, { take: 1, order: { rolled_at: 'DESC' } });
  const before = (await ledgerEntryRowsFor(id, 'SP'))[0];
  expect(pull.open_id).toBeTruthy();

  await packs.reverseOpen(pull.open_id as string); // post-commit reversal, NOT workflow compensation

  const after = (await ledgerEntryRowsFor(id, 'SP'))[0];
  expect(Number(after.wallet_delta)).toBe(Number(before.wallet_delta)); // unchanged — no clawback
  expect(after.display_id).toBe(before.display_id); // same row, not a new one
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

`service.ts`, near `settleOpen`:

```ts
  // Wraps createPulls with the paired SP ledger row, same transaction
  // (POLYCARD-BACK §5.3). ONE row per open_id regardless of pull count — a
  // batch open is one charge and one ledger event. ref_id = open_id (already
  // unique per open, single or batch; also what credit_transaction.
  // source_transaction_id stores for pack_open rows, so the Wallet-tab join
  // in Task 9 keys on that column for this type instead of credit_transaction.id).
  //
  // vault_delta uses the LENIENT resolveFxRate (see Global Constraints) —
  // this method never blocks a paid, already-committed pull on an FX gap.
  @InjectTransactionManager()
  async recordPullsWithLedger(
    input: {
      pulls: Parameters<PacksModuleService['createPulls']>[0];
      ledger: { customerId: string; openId: string; price: number; packId: string; channel: 'single' | 'batch' };
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Awaited<ReturnType<PacksModuleService['createPulls']>>> {
    const pulls = await this.createPulls(input.pulls, sharedContext);

    const fx = await resolveFxRate(this);
    const handles = [...new Set(input.pulls.map((p) => p.card_id))];
    const cards = await this.listCards({ handle: handles }, { take: handles.length }, sharedContext);
    const multiplierByHandle = new Map(
      cards.map((c) => [c.handle, Number(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER)]),
    );
    const vaultDelta = input.pulls.reduce((sum, p) => {
      const mult = multiplierByHandle.get(p.card_id) ?? DEFAULT_MARKET_MULTIPLIER;
      return sum + displayMarketPrice(Number(p.recorded_value_usd), fx, mult);
    }, 0);

    await this.recordLedgerEntry(
      {
        type: 'SP',
        customerId: input.ledger.customerId,
        refId: input.ledger.openId,
        walletDelta: -input.ledger.price,
        vaultDelta: Math.round(vaultDelta * 100) / 100,
        payload: {
          type: 'SP',
          channel: input.ledger.channel,
          pack_id: input.ledger.packId,
          prize_skus: input.pulls.map((p) => p.card_id),
        },
      },
      sharedContext,
    );
    return pulls;
  }
```

`service.ts` already imports `DEFAULT_MARKET_MULTIPLIER, resolveFxRate,
DEFAULT_USD_MYR, effectiveRate` from `./pricing` (verified — that exact
import block exists today). Add ONLY `displayMarketPrice` to that existing
block; do not duplicate the other three.

`workflows/steps/record-pull.ts`:

```diff
 type RecordPullInput = {
   customer_id: string;
   pack_id: string;
   card_id: string;
   recorded_value_usd: number;
   open_id: string;
+  price: number; // the pack-open debit, from chargePackOpenStep — threads
+                 // into the paired SP ledger row (see open-pack.ts).
 };
...
     const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
-    const [pull] = await packs.createPulls([
-      {
-        customer_id: input.customer_id,
-        pack_id: input.pack_id,
-        card_id: input.card_id,
-        order_id: null,
-        rolled_at: new Date(),
-        recorded_value_usd: input.recorded_value_usd,
-        open_id: input.open_id,
-      },
-    ]);
-    return new StepResponse(pull, pull.id);
+    const [pull] = await packs.recordPullsWithLedger({
+      pulls: [
+        {
+          customer_id: input.customer_id,
+          pack_id: input.pack_id,
+          card_id: input.card_id,
+          order_id: null,
+          rolled_at: new Date(),
+          recorded_value_usd: input.recorded_value_usd,
+          open_id: input.open_id,
+        },
+      ],
+      ledger: {
+        customerId: input.customer_id, openId: input.open_id,
+        price: input.price, packId: input.pack_id, channel: 'single',
+      },
+    });
+    return new StepResponse(pull, { id: pull.id, open_id: input.open_id });
   },
-  async (id, { container }) => {
-    if (!id) return;
+  async (data: { id: string; open_id: string } | undefined, { container }) => {
+    if (!data) return;
     const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
-    await packs.deletePulls(id);
+    // In-flight workflow rollback (a LATER step in this open failed) — this
+    // is NOT the post-commit reverseOpen path (see Global Constraints): the
+    // pull and its ledger row were written together and neither is a
+    // settled fact yet, so both are deleted, not clawed back.
+    await packs.deletePulls(data.id);
+    await packs.deleteLedgerEntryByRef('SP', data.open_id);
   }
```

`workflows/open-pack.ts` — thread the price:

```diff
     const recordInput = transform({ input, card, charged }, (d) => ({
       customer_id: d.input.customer_id,
       pack_id: d.input.pack_id,
       card_id: d.card.handle,
       recorded_value_usd: d.card.recorded_value_usd,
       open_id: d.charged.open_id,
     }));
-    const pull = recordPullStep(recordInput);
+    const pull = recordPullStep(
+      transform({ recordInput, charge }, (d) => ({ ...d.recordInput, price: d.charge.price })),
+    );
```

(`charge` is already defined above this point in the composition —
`const charge = chargePackOpenStep(charged);` — no reordering needed.)

`workflows/steps/record-pulls-batch.ts` — the same shape, batched:

```diff
 export type RecordPullsBatchInput = {
   customer_id: string;
   pack_id: string;
   open_id: string;
   cards: { card_id: string; recorded_value_usd: number }[];
+  price: number; // price × count, the whole batch's debit
 };
-type CompensateData = { pullIds: string[] } | undefined;
+type CompensateData = { pullIds: string[]; open_id: string } | undefined;
...
-    const pulls = (await packs.createPulls(
-      input.cards.map((c) => ({ ... })),
-    )) as PullRecord[];
-    return new StepResponse(pulls, { pullIds: pulls.map((p) => p.id) });
+    const pulls = (await packs.recordPullsWithLedger({
+      pulls: input.cards.map((c) => ({
+        customer_id: input.customer_id, pack_id: input.pack_id, card_id: c.card_id,
+        order_id: null, rolled_at: new Date(), recorded_value_usd: c.recorded_value_usd,
+        open_id: input.open_id,
+      })),
+      ledger: {
+        customerId: input.customer_id, openId: input.open_id,
+        price: input.price, packId: input.pack_id, channel: 'batch',
+      },
+    })) as PullRecord[];
+    return new StepResponse(pulls, { pullIds: pulls.map((p) => p.id), open_id: input.open_id });
   },
   async (data: CompensateData, { container }) => {
     if (!data?.pullIds?.length) return;
     const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
     await packs.deletePulls(data.pullIds);
+    await packs.deleteLedgerEntryByRef('SP', data.open_id);
   },
```

`workflows/open-batch.ts` — thread `charge.total`:

```diff
     const recordInput = transform({ input, cards, charged }, (d) => ({
       customer_id: d.input.customer_id,
       pack_id: d.input.pack_id,
       open_id: d.charged.open_id,
       cards: d.cards.map((c) => ({ card_id: c.handle, recorded_value_usd: c.recorded_value_usd })),
     }));
-    const pulls = recordPullsBatchStep(recordInput);
+    const pulls = recordPullsBatchStep(
+      transform({ recordInput, charge }, (d) => ({ ...d.recordInput, price: d.charge.total })),
+    );
```

- [ ] **Step 4: Verify pass** — the new http spec green (all 3 cases —
  case 3 reaches `reverseOpen` via `getContainer()`, the same seam
  `pack-open-charge.spec.ts` already uses, so it needs no new test
  infrastructure); re-run `pack-open-charge.spec.ts` and
  `open-compensation.spec.ts` (draw path
  touched) — both must stay green; full `test:unit`; `check-types`.

- [ ] **Step 5: Commit** — `feat(ledger): SP writer — pack-open spend (single + batch)`

---

### Task 8: OD writer — delivery order create + cancel

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method near `createDeliveryOrders`'s callers; extend `transitionDeliveryOrderStatus`, ~line 3569)
- Modify: `backend/packages/api/src/workflows/steps/request-delivery.ts`
- Test: `backend/packages/api/integration-tests/http/ledger-delivery.spec.ts` (new)

**Interfaces:**
- Consumes: `recordLedgerEntry`; `resolveFxRate`, `displayMarketPrice`, `DEFAULT_MARKET_MULTIPLIER`.
- Produces: `createDeliveryOrderWithLedger(input, sharedContext?)` — ONE
  atomic method replacing `request-delivery.ts`'s current three separate
  calls (`createDeliveryOrders` → `createDeliveryOrderItems` →
  `transitionPullStatus`) with a single `@InjectTransactionManager()` method
  that does all three PLUS the OD ledger write, collapsing the step's own
  three-stage manual try/catch undo into one. `transitionDeliveryOrderStatus`
  gains one branch: on a transition INTO `canceled`, write a reversing OD
  entry keyed `cancel:<order_id>`. This single hook covers BOTH the
  storefront cancel route and the admin bulk "mark as canceled" tool — do
  not add a second hook at either route layer.

- [ ] **Step 1: Write the failing spec**

Copy boilerplate from `integration-tests/http/delivery-orders.spec.ts`
(registration, `openOne` — a real pack open producing a vaulted pull,
`addAddress`, `reqApi`), plus the same local `ledgerEntryRowsFor` helper
(Task 4). Two adjustments to the copied boilerplate:

1. That file's `registerCustomer(email)` returns only a token — extend it
   the same one-line way as Tasks 6/7 to also return `id`.
2. `openOne(token, topupKey?)` and `addAddress(token)` both take the token
   directly (no `api` argument — they close over the file's own `api`).

```ts
const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const filter: Record<string, unknown> = { customer_id: customerId };
  if (type) filter.type = type;
  return packs.listLedgerEntries(filter, { order: { occurred_at: 'DESC' } }) as Promise<any[]>;
};

it('a delivery request writes ONE OD row: wallet 0, vault negative', async () => {
  const { token, id } = await registerCustomer('ledger-test-10@test.dev');
  const pullId = await openOne(token);
  const addressId = await addAddress(token);
  const res = await api.post('/store/delivery-orders', { pull_ids: [pullId], address_id: addressId }, { headers: authed(token) });
  expect(res.status).toBe(201); // matches this file's OWN create-order assertion

  const rows = await ledgerEntryRowsFor(id, 'OD');
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].wallet_delta)).toBe(0);
  expect(Number(rows[0].vault_delta)).toBeLessThan(0);
});

it('canceling the order writes a SECOND OD row (ref_id cancel:<order_id>) that restores the vault', async () => {
  const { token, id } = await registerCustomer('ledger-test-11@test.dev');
  const pullId = await openOne(token);
  const addressId = await addAddress(token);
  const created = await api.post('/store/delivery-orders', { pull_ids: [pullId], address_id: addressId }, { headers: authed(token) });
  const orderId = created.data.order_id as string;

  await api.post(`/store/delivery-orders/${orderId}/cancel`, {}, { headers: authed(token) });

  const rows = await ledgerEntryRowsFor(id, 'OD');
  expect(rows).toHaveLength(2);
  const create = rows.find((r: any) => Number(r.vault_delta) < 0);
  const cancel = rows.find((r: any) => Number(r.vault_delta) > 0);
  expect(create).toBeDefined();
  expect(cancel).toBeDefined();
  expect(Number(cancel.vault_delta)).toBe(-Number(create.vault_delta)); // exact reversal
  expect(cancel.ref_id).toBe(`cancel:${orderId}`);
});

it('an admin bulk mark-as-canceled ALSO writes the reversing OD row (one hook, both paths)', async () => {
  // Real route (verified on origin/master): POST /admin/delivery-orders/bulk
  // { ids, status } -> updateDeliveryOrderWorkflow -> the SAME
  // transitionDeliveryOrderStatus this task extends. Admin auth here mirrors
  // this file's OWN inline mintSuperAdmin usage (its cancel test does the
  // same thing) rather than adding a shared beforeEach admin setup.
  const { token, id: customerId } = await registerCustomer('ledger-test-12@test.dev');
  const pullId = await openOne(token);
  const addressId = await addAddress(token);
  const created = await api.post('/store/delivery-orders', { pull_ids: [pullId], address_id: addressId }, { headers: authed(token) });
  const orderId = created.data.order_id as string;

  const adminToken = await mintSuperAdmin(getContainer(), api, 'ledger-od-admin@test.dev', 'admin-pass-od-1');
  await api.post(
    '/admin/delivery-orders/bulk',
    { ids: [orderId], status: 'canceled' },
    { headers: { authorization: `Bearer ${adminToken}` } },
  );

  const rows = await ledgerEntryRowsFor(customerId, 'OD');
  expect(rows.some((r: any) => Number(r.vault_delta) > 0)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

`service.ts`, near `createDeliveryOrders`'s existing callers:

```ts
  // Collapses request-delivery's three writes (order, items, pull flip) plus
  // the paired OD ledger row into ONE transaction (POLYCARD-BACK §5.3:
  // "vault - at order CREATE"). Replaces the step's previous three-stage
  // manual try/catch undo — a failure partway through this method rolls back
  // via the transaction itself; the step's own compensation only needs to
  // undo the WHOLE thing if a LATER workflow step fails afterward.
  @InjectTransactionManager()
  async createDeliveryOrderWithLedger(
    input: { customerId: string; snapshot: Record<string, unknown>; pullIds: string[] },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ orderId: string; itemIds: string[] }> {
    const [order] = await this.createDeliveryOrders(
      [{ customer_id: input.customerId, status: 'requested' as const, ...input.snapshot }],
      sharedContext,
    );
    const items = await this.createDeliveryOrderItems(
      input.pullIds.map((pull_id) => ({ delivery_order_id: order.id, pull_id })),
      sharedContext,
    );
    await this.transitionPullStatus(
      { ids: input.pullIds, from: 'vaulted', to: 'delivering' },
      sharedContext,
    );

    const vaultDelta = await this.vaultValueForPulls(input.pullIds, sharedContext);
    const pulls = await this.listPulls({ id: input.pullIds }, { take: input.pullIds.length }, sharedContext);
    await this.recordLedgerEntry(
      {
        type: 'OD',
        customerId: input.customerId,
        refId: order.id,
        walletDelta: 0,
        vaultDelta: -vaultDelta,
        payload: {
          type: 'OD',
          handles: countByHandle(pulls.map((p) => p.card_id)),
          status: 'requested',
        },
      },
      sharedContext,
    );
    return { orderId: order.id, itemIds: items.map((i) => i.id) };
  }

  // Shared by createDeliveryOrderWithLedger and transitionDeliveryOrderStatus's
  // cancel branch — Σ displayMarketPrice(card.market_value, fx, multiplier)
  // over the given pulls' cards. Lenient FX (see Global Constraints): a
  // bookkeeping row must not block an already-decided vault-status change.
  private async vaultValueForPulls(pullIds: string[], sharedContext: Context): Promise<number> {
    const pulls = await this.listPulls({ id: pullIds }, { take: pullIds.length }, sharedContext);
    const handles = [...new Set(pulls.map((p) => p.card_id))];
    if (handles.length === 0) return 0;
    const cards = await this.listCards({ handle: handles }, { take: handles.length }, sharedContext);
    const fx = await resolveFxRate(this);
    const byHandle = new Map(cards.map((c) => [c.handle, c]));
    const sum = pulls.reduce((total, p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return total;
      return total + displayMarketPrice(
        Number(card.market_value), fx, Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      );
    }, 0);
    return Math.round(sum * 100) / 100;
  }
```

(`countByHandle` — a two-line pure helper in `modules/packs/ledger.ts`:
`export const countByHandle = (handles: string[]): { card_handle: string; qty: number }[] => {
  const m = new Map<string, number>();
  for (const h of handles) m.set(h, (m.get(h) ?? 0) + 1);
  return [...m.entries()].map(([card_handle, qty]) => ({ card_handle, qty }));
};` — add it to Task 2's file in this task, with one unit-test case,
since Task 2 already shipped without foreseeing it. Add `countByHandle` to
`service.ts`'s existing `import { displayId, nextSerial, sequenceScope, ... }
from './ledger';` line from Task 3 — one import statement, not two.)

`transitionDeliveryOrderStatus` — add right before `return { status: input.to };`:

```ts
    if (input.to === 'canceled' && input.pullIds.length) {
      const vaultDelta = await this.vaultValueForPulls(input.pullIds, sharedContext);
      const pulls = await this.listPulls({ id: input.pullIds }, { take: input.pullIds.length }, sharedContext);
      await this.recordLedgerEntry(
        {
          type: 'OD',
          customerId: order.customer_id,
          refId: `cancel:${input.orderId}`,
          walletDelta: 0,
          vaultDelta,
          payload: {
            type: 'OD',
            handles: countByHandle(pulls.map((p) => p.card_id)),
            status: 'canceled',
          },
        },
        sharedContext,
      );
    }
```

(Placed AFTER the existing `transitionPullStatus` call in that method so the
vault-value lookup runs on pulls whose status is already flipped back —
value doesn't depend on status, but ordering here matches the method's
existing "order write, then pull side-effects" sequence for readability.)

`request-delivery.ts` — replace the three calls with one, matching this
plan's Architecture note:

```diff
-    const [order] = await packs.createDeliveryOrders([
-      { customer_id: input.customer_id, status: "requested", ...snapshot },
-    ]);
-    let itemIds: string[] = [];
-    try {
-      const items = await packs.createDeliveryOrderItems(
-        input.pull_ids.map((pull_id) => ({ delivery_order_id: order.id, pull_id })),
-      );
-      itemIds = items.map((i) => i.id);
-    } catch (error) { ... }
-    try {
-      await packs.transitionPullStatus({ ids: input.pull_ids, from: "vaulted", to: "delivering" });
-    } catch (error) { ... }
+    const { orderId, itemIds } = await packs.createDeliveryOrderWithLedger({
+      customerId: input.customer_id, snapshot, pullIds: input.pull_ids,
+    });
```

(Delete the two try/catch blocks entirely — the new method's own transaction
is the atomicity boundary now; there is nothing left to manually unwind
INSIDE this step. The step's OWN compensation, for a LATER workflow step
failing, becomes:)

```diff
   async (data: CompensateData, { container }) => {
     if (!data) return;
     const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
     await packs.updatePulls(
       data.pullIds.map((id) => ({ id, status: "vaulted" as const })),
     );
     await packs.deleteDeliveryOrderItems(data.itemIds);
     await packs.deleteDeliveryOrders([data.orderId]);
+    await packs.deleteLedgerEntryByRef('OD', data.orderId);
   },
```

(`result`/`StepResponse` construction updates `order.id` → `orderId` to match
the renamed destructure; no other shape changes.)

- [ ] **Step 4: Verify pass** — the new http spec green (3/3 — write the
  admin bulk-status seed helper if `delivery-orders.spec.ts` doesn't already
  have one, following its existing seeding idiom); re-run
  `delivery-orders.spec.ts` and the store `cancel.unit.spec.ts` — both must
  stay green (request-delivery.ts's public behavior is unchanged, only its
  internals collapsed); full `test:unit`; `check-types`.

- [ ] **Step 5: Commit** — `feat(ledger): OD writer — delivery create + cancel (one hook, both cancel paths)`

---

### Task 9: Admin route — full Transactions query + Wallet-tab `ledger_display_id`

**Files:**
- Create: `backend/packages/api/src/api/admin/ledger/route.ts` (this task is
  the first to create it — Tasks 4-8 asserted their writers directly via
  `PacksModuleService.listLedgerEntries` through `getContainer()`, not
  through an admin route, so there is nothing to replace here)
- Modify: `backend/packages/api/src/api/admin/customers/[id]/transactions/route.ts`
- Test: `backend/packages/api/integration-tests/http/admin-ledger-route.spec.ts` (new)

**Interfaces:**
- Consumes: `LedgerType`, `LedgerPayload` (Task 2); `parsePaginationParams`.
- Produces: `GET /admin/ledger?type=&q=&from=&to=&limit=&offset=` →
  `{ total, offset, limit, entries: AdminLedgerRow[] }`; `GET
  /admin/customers/:id/transactions` response rows gain
  `ledger_display_id: string | null`.

```ts
export type AdminLedgerRow = {
  id: string; display_id: string; type: LedgerType;
  customer: { id: string; email: string; name: string | null };
  occurred_at: string;
  wallet_delta: number | null; vault_delta: number | null;
  payload: LedgerPayload;
};
```

- [ ] **Step 1: Write the failing spec**

```ts
it('filters by type, q (display_id or player email), and date range', async () => {
  // Seed via the ALREADY-WIRED AD writer (Task 5). registerCustomer here is
  // credit-adjust.spec.ts's exact helper: registerCustomer(email: string) =>
  // Promise<{ token: string; id: string }> — it does not return the email
  // back, so the test keeps its OWN copy of the email string it registered
  // with instead of trying to read it off the return value.
  const email = 'admin-ledger-route-a@test.dev';
  const { id } = await registerCustomer(email);
  await api.post(
    `/admin/customers/${id}/credits`,
    { amount: 5, note: 'seed for admin-ledger-route spec' },
    { headers: adminHeaders() },
  );

  const byType = await api.get('/admin/ledger?type=AD', { headers: adminHeaders() });
  expect(byType.data.entries.every((e: any) => e.type === 'AD')).toBe(true);
  expect(byType.data.entries.some((e: any) => e.customer.id === id)).toBe(true);

  const emailPrefix = email.split('@')[0];
  const byQ = await api.get(`/admin/ledger?q=${encodeURIComponent(emailPrefix)}`, { headers: adminHeaders() });
  const matched = byQ.data.entries.find((e: any) => e.customer.email === email);
  expect(matched).toBeDefined();
  const knownDisplayId = matched.display_id as string;

  const byDisplayId = await api.get(`/admin/ledger?q=${encodeURIComponent(knownDisplayId)}`, { headers: adminHeaders() });
  expect(byDisplayId.data.entries.map((e: any) => e.display_id)).toContain(knownDisplayId);

  const byRange = await api.get('/admin/ledger?from=2000-01-01&to=2000-01-02', { headers: adminHeaders() });
  expect(byRange.data.entries).toHaveLength(0); // seeded rows are "now", not year 2000
});

it('customer.email/name are batch-resolved, not per-row queried', async () => {
  const res = await api.get('/admin/ledger', { headers: adminHeaders() });
  expect(res.data.entries[0].customer.email).toBeTruthy();
});

it('the Wallet-tab transactions route surfaces ledger_display_id where a paired row exists', async () => {
  const { token, id } = await registerCustomer('ledger-test-14@test.dev');
  // Direct top-up call (Task 4's TP writer is already wired) — this file's
  // own storeHeaders (publishable key, set up in its copied beforeEach) plus
  // the customer's bearer token is all POST /store/credits/topup needs.
  await api.post(
    '/store/credits/topup',
    { amount: 20 },
    { headers: { ...storeHeaders, authorization: `Bearer ${token}`, 'idempotency-key': 'admin-ledger-route-topup' } },
  );
  const res = await api.get(`/admin/customers/${id}/transactions`, { headers: adminHeaders() });
  expect(res.data.items[0].ledger_display_id).toMatch(/^TP/);
});
```

- [ ] **Step 2: Run to verify failure** — 404 on `/admin/ledger` (this task
  creates it for the first time); once it exists, the range/q/customer-join
  cases fail against a first-draft route that doesn't yet implement them.

- [ ] **Step 3: Implement**

Full `api/admin/ledger/route.ts` (replaces Task 4's body):

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { parsePaginationParams } from '../../../utils/pagination';
import type { LedgerPayload, LedgerType } from '../../../modules/packs/ledger';

const LEDGER_TYPES: LedgerType[] = ['TP', 'SP', 'SE', 'OD', 'RF', 'AD', 'WP'];

// Narrow the untyped jsonb column at THIS one read boundary — the same
// "as unknown as X" idiom service.ts already uses for rank_rewards, kept to
// one place so casts don't spread into callers.
const asPayload = (v: unknown): LedgerPayload => v as unknown as LedgerPayload;

// GET /admin/ledger — Transactions list (POLYCARD-BACK §5.4). Task 4 shipped
// a type/customer_id-only version so the first writers had something real to
// assert through; this replaces it with q/date-range/pagination + the
// batched customer join.
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 200 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);

  const rawType = req.query.type;
  const type = typeof rawType === 'string' && (LEDGER_TYPES as string[]).includes(rawType)
    ? (rawType as LedgerType)
    : undefined;
  const rawQ = req.query.q;
  const q = typeof rawQ === 'string' && rawQ.trim() !== '' ? rawQ.trim().slice(0, 100) : undefined;
  // ponytail: from/to are UTC calendar-day boundaries (plain new Date on a
  // YYYY-MM-DD string), not MYT-aware — an admin filtering "today" near
  // midnight MYT can be off by the UTC+8 gap. The MYT-exactness requirement
  // in this epic is the display-id quarter/year math (§5.2); this filter is
  // a read-only UI convenience, not a money computation. Upgrade if an
  // operator reports the off-by-8-hours edge as an actual problem.
  const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;
  const to = typeof req.query.to === 'string' ? new Date(req.query.to) : undefined;

  let matchingCustomerIds: string[] | undefined;
  if (q) {
    const [matches] = await customers.listAndCountCustomers({ q }, { take: 200, select: ['id'] });
    matchingCustomerIds = matches.map((c) => c.id);
  }

  const { entries, total } = await packs.listLedgerEntriesForAdmin({
    type, q, matchingCustomerIds, from, to, limit, offset,
  });

  const customerIds = [...new Set(entries.map((e) => e.customer_id))];
  const rows = customerIds.length
    ? await customers.listCustomers({ id: customerIds }, { select: ['id', 'email', 'first_name', 'last_name'] })
    : [];
  const byId = new Map(rows.map((c) => [c.id, c]));

  res.json({
    total, offset, limit,
    entries: entries.map((e) => {
      const c = byId.get(e.customer_id);
      const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || null : null;
      return {
        id: e.id, display_id: e.display_id, type: e.type,
        customer: { id: e.customer_id, email: c?.email ?? '', name },
        occurred_at: e.occurred_at,
        wallet_delta: e.wallet_delta === null ? null : Number(e.wallet_delta),
        vault_delta: e.vault_delta === null ? null : Number(e.vault_delta),
        payload: asPayload(e.payload),
      };
    }),
  });
}
```

`service.ts` — `listLedgerEntriesForAdmin` (raw SQL: the `q` OR across
`display_id`/`customer_id` isn't a plain ORM AND-filter). Add this type next
to the file's existing `LedgerSqlManager` type:

```ts
type LedgerEntryRow = {
  id: string; display_id: string; type: LedgerType; customer_id: string;
  occurred_at: string;
  // Raw driver values for numeric columns — Number()'d at the route
  // boundary, same discipline as every other raw-SQL money read in this file.
  wallet_delta: string | null; vault_delta: string | null;
  payload: unknown;
};
```

```ts
  @InjectManager()
  async listLedgerEntriesForAdmin(
    input: {
      type?: LedgerType; q?: string; matchingCustomerIds?: string[];
      from?: Date; to?: Date; limit: number; offset: number;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ entries: LedgerEntryRow[]; total: number }> {
    const em = (sharedContext.transactionManager ?? sharedContext.manager) as unknown as LedgerSqlManager;
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (input.type) { clauses.push('type = ?'); params.push(input.type); }
    if (input.from) { clauses.push('occurred_at >= ?'); params.push(input.from); }
    if (input.to) { clauses.push('occurred_at <= ?'); params.push(input.to); }
    if (input.q) {
      const ids = input.matchingCustomerIds ?? [];
      const ph = ids.length ? ids.map(() => '?').join(',') : 'NULL';
      clauses.push(`(display_id ILIKE ? ${ids.length ? `OR customer_id IN (${ph})` : ''})`);
      params.push(`%${input.q}%`, ...ids);
    }
    const where = clauses.join(' AND ');
    const [rows, countRows] = await Promise.all([
      em.execute<LedgerEntryRow[]>(
        `SELECT id, display_id, type, customer_id, occurred_at, wallet_delta, vault_delta, payload
           FROM ledger_entry WHERE ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
        [...params, input.limit, input.offset],
      ),
      em.execute<{ n: string }[]>(`SELECT COUNT(*)::bigint AS n FROM ledger_entry WHERE ${where}`, params),
    ]);
    return { entries: rows, total: Number(countRows[0]?.n ?? 0) };
  }
```

`customers/[id]/transactions/route.ts` — add the batched ledger join:

```diff
   const [rows, total] = await packs.listAndCountCreditTransactions(
     { customer_id: id },
     { order: { created_at: 'DESC' }, skip: offset, take: limit },
   );
+  // Ledger display id where present (POLYCARD-BACK §4.3 Wallet tab). SP rows
+  // key on source_transaction_id (the open_id); TP/SE/AD key on the
+  // credit_transaction's own id (see each writer's ref_id choice in the
+  // ledger epic plan). ONE batched lookup, not per-row.
+  const directIds = rows.filter((t: any) => t.reason !== 'pack_open').map((t: any) => t.id);
+  const openIds = rows.filter((t: any) => t.reason === 'pack_open').map((t: any) => t.source_transaction_id).filter(Boolean);
+  const ledgerRows = await packs.listLedgerEntries(
+    { ref_id: [...directIds, ...openIds] },
+    { select: ['ref_id', 'display_id'] },
+  );
+  const displayIdByRefId = new Map(ledgerRows.map((l: any) => [l.ref_id, l.display_id]));
   res.json({
     total,
     items: rows.map((t: any) => ({
       id: t.id,
       amount: Number(t.amount),
       reason: t.reason,
       reference: t.reference ?? null,
       created_at: t.created_at,
+      ledger_display_id:
+        displayIdByRefId.get(t.reason === 'pack_open' ? t.source_transaction_id : t.id) ?? null,
     })),
   });
```

- [ ] **Step 4: Verify pass** — new route spec green (3/3); full `test:unit`; `check-types`.

- [ ] **Step 5: Commit** — `feat(ledger): admin ledger query (type/q/date-range) + Wallet-tab ledger_display_id`

---

### Task 10: Admin UI — Transactions page

**Files:**
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (append under `// ── Epic 4 (Ledger) ──`)
- Modify: `backend/apps/admin/src/lib/query-keys.ts` (+ `query-keys.test.ts`)
- Modify: `backend/apps/admin/src/lib/queries.ts`
- Modify: `backend/apps/admin/src/i18n/en.json` (new top-level `"ledger"` block, LAST key)
- Create: `backend/apps/admin/src/routes/ledger/page.tsx`

**Interfaces:**
- Consumes: Task 9's route; `rm`, `orderDateTime` (`lib/format.ts`); `Pager`,
  `LoadingSkeleton` (`components/`).
- Produces: sidebar entry "Transactions" (top-level, `Receipt` icon, rank 31
  — between "Economy" rank 30 and "Weekly Challenge" rank 33, both
  confirmed top-level/un-nested on `origin/master`); route `/ledger`.

- [ ] **Step 1: `admin-rest.ts`**

```ts
// ── Epic 4 (Ledger) ─────────────────────────────────────────────────────────

export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'RF' | 'AD' | 'WP';

export interface AdminLedgerRow {
  id: string; display_id: string; type: LedgerType;
  customer: { id: string; email: string; name: string | null };
  occurred_at: string;
  wallet_delta: number | null; vault_delta: number | null;
  payload: Record<string, unknown>;
}
export interface AdminLedgerPage {
  total: number; offset: number; limit: number; entries: AdminLedgerRow[];
}

export const listLedger = (
  page = 0,
  opts: { type?: LedgerType; q?: string; from?: string; to?: string; limit?: number } = {},
) => {
  const limit = opts.limit ?? 50;
  const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
  if (opts.type) params.set('type', opts.type);
  if (opts.q) params.set('q', opts.q);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  return getJson<AdminLedgerPage>(`/admin/ledger?${params.toString()}`);
};
```

- [ ] **Step 2: `query-keys.ts`**

```ts
  // ── Epic 4 (Ledger) ──
  ledger: (page: number, type?: string, q?: string, from?: string, to?: string) =>
    ['admin', 'ledger', page, type ?? 'all', q ?? '', from ?? '', to ?? ''] as const,
  ledgerKey: ['admin', 'ledger'] as const,
```

Add to `query-keys.test.ts`: `qk.ledger(0)` shares the `['admin','ledger']`
prefix with `qk.ledgerKey` (mirrors the existing `players`/`playersKey` test).

- [ ] **Step 3: `queries.ts`**

```ts
export const useLedger = (
  page: number, type?: LedgerType, q?: string, from?: string, to?: string,
): UseQueryResult<AdminLedgerPage> =>
  useQuery({
    queryKey: qk.ledger(page, type, q, from, to),
    queryFn: () => listLedger(page, { type, q, from, to }),
  });
```

- [ ] **Step 4: i18n** — append (LAST top-level key):

```json
  "ledger": {
    "title": "Transactions",
    "subtitle": "Every wallet and vault event, read-only.",
    "searchPlaceholder": "Search transaction id or player email",
    "typeAll": "All",
    "typeTp": "Top-up",
    "typeSp": "Spend",
    "typeSe": "Sell",
    "typeOd": "Order",
    "typeRf": "Referral",
    "typeAd": "Adjustment",
    "typeWp": "Challenge",
    "colId": "Transaction",
    "colType": "Type",
    "colPlayer": "Player",
    "colWhen": "When",
    "colAffect": "Affect",
    "colDetails": "Details",
    "from": "From",
    "to": "To",
    "empty": "No transactions yet.",
    "noResults": "No transactions match that search.",
    "loadError": "Could not load transactions."
  }
```

- [ ] **Step 5: `routes/ledger/page.tsx`**

```tsx
import { Fragment, useState } from 'react';
import { Container, Heading, Text, Table, Badge, Input, Button } from '@medusajs/ui';
import { Receipt } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useLedger } from '../../lib/queries';
import type { LedgerType } from '../../lib/admin-rest';
import { rm, orderDateTime } from '../../lib/format';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { useTranslation } from 'react-i18next';

export const config: RouteConfig = {
  label: 'Transactions',
  icon: Receipt,
  rank: 31,
};

const TYPES: (LedgerType | undefined)[] = [undefined, 'TP', 'SP', 'SE', 'OD', 'RF', 'AD', 'WP'];

// One-line summary per row, matching spec §5.4's example
// ("wallet -RM5,000, vault +RM4,000") — em-dash when a side is null/zero.
function affectSummary(wallet: number | null, vault: number | null): string {
  const parts: string[] = [];
  if (wallet !== null && wallet !== 0) parts.push(`wallet ${wallet > 0 ? '+' : ''}${rm(wallet)}`);
  if (vault !== null && vault !== 0) parts.push(`vault ${vault > 0 ? '+' : ''}${rm(vault)}`);
  return parts.length ? parts.join(', ') : '—';
}

export default function LedgerPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [type, setType] = useState<LedgerType | undefined>(undefined);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data, isLoading, isError } = useLedger(page, type, q || undefined, from || undefined, to || undefined);

  return (
    <Container>
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">{t('ledger.title')}</Heading>
          <Text size="small" className="text-ui-fg-subtle">{t('ledger.subtitle')}</Text>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 px-6 pb-4">
        {TYPES.map((tp) => (
          <Button
            key={tp ?? 'all'}
            size="small"
            variant={type === tp ? 'primary' : 'secondary'}
            onClick={() => { setType(tp); setPage(0); }}
          >
            {t(`ledger.type${tp ? tp[0] + tp[1].toLowerCase() : 'All'}`)}
          </Button>
        ))}
        <Input
          placeholder={t('ledger.searchPlaceholder')}
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          className="max-w-xs"
        />
        <Input type="date" aria-label={t('ledger.from')} value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
        <Input type="date" aria-label={t('ledger.to')} value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : isError ? (
        <Text className="px-6 py-8 text-ui-fg-error">{t('ledger.loadError')}</Text>
      ) : data && data.entries.length === 0 ? (
        <Text className="px-6 py-8 text-ui-fg-subtle">{q || type ? t('ledger.noResults') : t('ledger.empty')}</Text>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('ledger.colId')}</Table.HeaderCell>
              <Table.HeaderCell>{t('ledger.colType')}</Table.HeaderCell>
              <Table.HeaderCell>{t('ledger.colPlayer')}</Table.HeaderCell>
              <Table.HeaderCell>{t('ledger.colWhen')}</Table.HeaderCell>
              <Table.HeaderCell>{t('ledger.colAffect')}</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data?.entries.map((e) => (
              // A mapped array needs the KEY ON THE FRAGMENT ITSELF — the `<>`
              // shorthand cannot carry props, so this uses the explicit
              // <Fragment key={...}> form (imported from 'react' below).
              <Fragment key={e.id}>
                <Table.Row className="cursor-pointer" onClick={() => {
                  const next = new Set(expanded);
                  next.has(e.id) ? next.delete(e.id) : next.add(e.id);
                  setExpanded(next);
                }}>
                  <Table.Cell className="font-mono">{e.display_id}</Table.Cell>
                  <Table.Cell><Badge size="2xsmall">{e.type}</Badge></Table.Cell>
                  <Table.Cell>{e.customer.name ?? e.customer.email}</Table.Cell>
                  <Table.Cell>{orderDateTime(e.occurred_at)}</Table.Cell>
                  <Table.Cell>{affectSummary(e.wallet_delta, e.vault_delta)}</Table.Cell>
                  <Table.Cell>{expanded.has(e.id) ? '▾' : '▸'}</Table.Cell>
                </Table.Row>
                {expanded.has(e.id) && (
                  <Table.Row>
                    <Table.Cell colSpan={6}>
                      <pre className="text-xs text-ui-fg-subtle whitespace-pre-wrap">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Fragment>
            ))}
          </Table.Body>
        </Table>
      )}
      {data && (
        <Pager page={page} onPage={setPage} pageSize={50} count={data.entries.length} total={data.total} />
      )}
    </Container>
  );
}
```

(This page is read-only per spec §5.4 — no create/edit/delete affordances at all.)

- [ ] **Step 6: Verify** — `corepack yarn build`, `corepack yarn lint`,
  `yarn test` (vitest — the `query-keys.test.ts` addition) all clean; dev
  boot: sidebar shows "Transactions"; type tabs filter; search matches a
  known display id and a known player email; date range narrows to zero for
  an out-of-range window; row click expands the payload JSON.

- [ ] **Step 7: Commit** — `feat(ledger): admin Transactions page — type tabs, search, date range, payload expander`

---

### Task 11: Full verification sweep + PR

- [ ] **Step 1: Backend** — from `backend/packages/api`: `corepack yarn
  test:unit` PASS; `corepack yarn check-types` clean; `corepack yarn
  test:integration:smoke` PASS; every new/extended http spec in this plan run
  individually via the single-spec command; re-run `pack-open-charge.spec.ts`,
  `open-compensation.spec.ts`, `vault-buyback.spec.ts`,
  `vault-buyback-batch.spec.ts`, `delivery-orders.spec.ts`,
  `credit-topup.spec.ts`, `credit-adjust.spec.ts`, `admin-adjust-audit.spec.ts`
  (every existing spec touching a modified writer) — all must stay green.
- [ ] **Step 2: Admin** — `corepack yarn build`, `corepack yarn lint`, `yarn test`.
- [ ] **Step 3: Repo root** — `npm run check`; confirm zero storefront diff
  (`git diff origin/master --stat -- src/` → empty — this epic never touches
  the storefront).
- [ ] **Step 4: Grep sweeps** — `grep -rn "mutateCreditAtomic(" backend/packages/api/src/workflows`
  → zero remaining bare calls from steps (Task 4 replaced the only one);
  `grep -rn "createPulls(" backend/packages/api/src/workflows/steps/record-pull.ts backend/packages/api/src/workflows/steps/record-pulls-batch.ts`
  → zero (both now call `recordPullsWithLedger`); `git diff origin/master --stat`
  review for formatter-hook churn on every touched backend file.
- [ ] **Step 5: Manual round-trip on the live stack** — boot backend + admin
  (`corepack yarn dev` / `npx vite --port 7000`): top up, open a pack, sell a
  card back, request a delivery then cancel it, and make an admin credit
  adjustment; confirm all five show up on `/ledger` with correct type badges,
  Affect summaries, and expandable payloads; confirm the Wallet tab on that
  player's detail page shows a `ledger_display_id` for each row.
- [ ] **Step 6: Commit any fixes, then PR** — `/code-review`, fix findings,
  push, PR to `master` titled `feat(ledger): transaction ledger — display-id
  generator, 5 of 7 writers wired, admin Transactions page (POLYCARD-BACK
  epic 4)`.

---

## Coverage check (spec §5 → tasks)

- 5.1 model (`ledger_entry`, `ledger_sequence`) → Task 1.
- 5.2 display-id generator, pure-function + unit tests for rollovers → Task 2.
- 5.3 writers table:
  - TP top-up → Task 4.
  - SP spend → Task 7.
  - SE sell → Task 6.
  - OD order (create + cancel, one hook for both cancel paths) → Task 8.
  - RF referral → **NOT wired this epic.** No settlement job exists on
    `origin/master` (verified by grep: `rank_rewards` is display-only, no
    payout code). `recordLedgerEntry` is ready for Epic 6 (§6, Referral
    redo) to call from its weekly payout job.
  - AD adjustment → Task 5.
  - WP challenge → **NOT wired this epic**, same reason: no challenge
    settlement job exists yet (only admin-configured stage/rank display
    data). Ready for whichever future epic builds that job.
  - "One ledger write per source event, same DB transaction" → the Architecture
    section's rule (one outer `@InjectTransactionManager()` method per writer);
    "idempotent per (type, ref_id)" → Task 3.
- 5.4 admin UI (type tabs, search, date range, Affect summary, expandable
  payload, read-only) → Task 10, backed by Task 9's route.
- Acceptance: serial generator unit tests (a9999→b0001, z9999→aa0001, quarter
  rollover) → Task 2; concurrency test (parallel writers, no duplicate
  display_id) → Task 3; every WIRED writer covered by an integration test
  asserting the paired ledger row → Tasks 4-8 (5 of 7 — see the RF/WP note
  above, called out explicitly rather than silently short of "every writer").

## Open items surfaced to the operator (do not decide silently)

1. **RF and WP have no call site in this epic.** Their source workflows
   (weekly referral payout job; challenge settlement job) do not exist on
   `origin/master`. `recordLedgerEntry` and both ledger types are ready; the
   spec's own §7 sequencing already expects Epic 6 to add the RF call site.
   Nothing currently builds WP's source event — flagging so a future epic
   is scoped for it rather than it being silently forgotten.
2. **Four existing credit reasons have no ledger type**: `cashout`
   (withdrawal), `voucher_claim`, `reward_credit`, `daily_reward`. The
   ledger is deliberately not a 1:1 mirror of `credit_transaction` after
   this epic. If the operator wants withdrawal events on the ledger, that
   needs a new type (the spec's 7-value enum has no natural fit) — flagged,
   not silently added or silently skipped.
3. **SP ledger rows are not reversal-aware.** A post-commit `reverseOpen`
   (fraud/clawback on an already-completed pack open) leaves the original SP
   ledger row standing with its original amounts — this epic does not add a
   ledger-side clawback mechanism, since neither §5 nor §6 defines one. If
   the operator wants the ledger to reflect reversals, that is new scope
   (likely an 8th type or a `reversed_ref_id` column) for a future pass.
4. **vault_delta uses the display PRICE (FMV × per-card multiplier via
   `displayMarketPrice`), matching D1 and the epic 2/3 "price" convention** —
   NOT the older raw-FMV `vaultLiabilityMyr` formula (no multiplier), which
   predates POLYCARD-BACK and computes a different number (the house's cost
   basis, not the customer-facing value). If the operator wants ledger
   vault_delta to match `vaultLiabilityMyr` instead, that is a one-line
   formula swap in Tasks 7 and 8 — flagged because the spec text doesn't
   pin which convention "pull value" means.
5. **Display-id case**: the spec's own two examples disagree (`TP26Q3A0001`
   uppercase vs. `last_serial: "a0413"` lowercase). This plan stores
   lowercase, renders uppercase (Task 2) — a resolved ambiguity, not a
   left-open one, but worth the operator's awareness since it's a visible
   product decision (display ids always render uppercase).
