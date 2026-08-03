# Plan 076: Admin editors mirror the server money ceilings inline; three stale comments corrected

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- backend/apps/admin/src/routes/challenge/page.tsx backend/apps/admin/src/routes/daily-rewards/vip-levels-validate-client.ts backend/apps/admin/src/routes/ledger/page.tsx`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — strictly narrower client gates in front of unchanged server gates; comment/format edits
- **Depends on**: none
- **Category**: bug / tech-debt
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

Both admin money editors state a contract their code doesn't meet: "mirrors
the server invariants so the operator sees problems inline before POSTing."
The server caps per-rank challenge credits and VIP voucher amounts at
`MAX_VOUCHER_MYR` (10,000) and stage thresholds at `MAX_THRESHOLD_MYR`
(100,000,000); the client validators check only `>= 0`. An over-cap figure
passes inline, the save 400s, and the operator gets a generic toast with no
field or row. No bad data can be written — this is pure operator UX plus
three comments that actively misinform the next reader (one claims plan 044's
shipped cap doesn't exist; one claims the WP ledger writer doesn't exist; one
points at a deleted tab). Plus one money figure rendered without the shared
formatter.

## Current state

**Client checks missing the ceilings**:

`backend/apps/admin/src/routes/challenge/page.tsx:113-117`:

```ts
const parseCredits = (v: string): number => (v.trim() === '' ? 0 : Number(v));
const creditsValid = (v: string): boolean => {
  const n = parseCredits(v);
  return Number.isFinite(n) && n >= 0;
};
```

`challenge/page.tsx:200-204` (thresholds): `Number.isFinite(t) || t < 0`
checks only; no upper bound.

`backend/apps/admin/src/routes/daily-rewards/vip-levels-validate-client.ts:37-39`:

```ts
const v = num(r.voucherInput);
if (!Number.isFinite(v) || v < 0)
  errors.push(`Level ${level}: voucher amount must be ≥ 0.`);
```

**The server truth being mirrored**:

`backend/packages/api/src/modules/packs/challenge-validate.ts:71-80` — per-rank
credits `> MAX_VOUCHER_MYR` rejected ("Per-rank credits mint real balance, so
they share the voucher ceiling (plan 044)"); `:115-118` —
`threshold_myr > MAX_THRESHOLD_MYR` rejected.
`backend/packages/api/src/modules/packs/vip-levels-validate.ts:55-64` —
`voucher_amount > MAX_VOUCHER_MYR` rejected.

**The mirror convention** (the admin app deliberately duplicates backend
constants as literals — separate builds, no shared package) —
`backend/apps/admin/src/lib/purchase-invoice-form.ts:18-21`:

```ts
// Mirrors api/admin/purchase-invoices/validate.ts. Kept as literals rather than
// imported: the admin app and the Medusa backend are separate builds with no
// shared package (same duplication the format.ts mirrors already carry).
const MAX_MONEY = 1_000_000;
```

**Stale comments**:

1. `challenge/page.tsx:194`: "A per-rank reward cap (plan 044) would slot in
   beside the credits check." — the cap is live server-side
   (`challenge-validate.ts:76`); this comment describes the missing client
   half as if the whole thing were unbuilt.
2. `backend/apps/admin/src/routes/ledger/page.tsx:27-30`: "RF (referral
   payout) and WP (challenge settlement) stay listed even though no writer
   produces them yet" — WP has had a writer since plan 060
   (`settleChallengeWinner`); the backend's own comment at
   `api/admin/ledger/route.ts:72-75` states it correctly. Only RF is
   writerless (Epic 6 cancelled).
3. `vip-levels-validate-client.ts:1-3`: "(parity with the Vouchers tab's
   foldRangesLocal)" — the Vouchers tab no longer exists (the Levels tab
   writes `voucher_amount` directly).

**Unformatted money** — `challenge/page.tsx:333`:

```ts
creditTotal > 0 ? `RM ${creditTotal} credits` : null,
```

renders a raw JS number beside surfaces that use `rm()`
(`backend/apps/admin/src/lib/format.ts` — thousands separator + fixed 2dp).

## Commands you will need

| Purpose            | Command (from `backend/apps/admin`)                                                                                                                                                      | Expected |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Build (typechecks) | `corepack yarn build` — if it fails oddly, the machine's global TS7 shadows the pinned 5.9.3; use `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` to verify types | exit 0   |
| Admin unit tests   | `corepack yarn test` (vitest)                                                                                                                                                            | all pass |

## Scope

**In scope**:

- `backend/apps/admin/src/routes/challenge/page.tsx`
- `backend/apps/admin/src/routes/daily-rewards/vip-levels-validate-client.ts`
- `backend/apps/admin/src/routes/ledger/page.tsx` (comment only)
- The colocated spec for the vip client validator if one exists (extend); the
  challenge page's validator spec likewise

**Out of scope**:

- Both server validators (`challenge-validate.ts`, `vip-levels-validate.ts`) —
  they are correct and are the source being mirrored.
- The orphaned voucher-ladder chain (`useVoucherLadder` etc.) — a separate
  operator decision recorded in plans/README round 9; do not delete it here.
- Error-toast plumbing (`onSave`'s generic catch) — the inline checks make it
  moot for these fields.

## Git workflow

- Branch: `advisor/076-admin-cap-mirrors`
- Conventional commit, e.g. `fix(admin): mirror the server money ceilings in the challenge/VIP inline validators`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the ceilings as COUPLED MIRROR literals

In `challenge/page.tsx`, near `parseCredits`:

```ts
// COUPLED MIRROR of modules/packs/challenge-validate.ts (MAX_VOUCHER_MYR /
// MAX_THRESHOLD_MYR). Kept as literals — separate builds, no shared package
// (same convention as lib/purchase-invoice-form.ts).
const MAX_CREDITS_MYR = 10_000;
const MAX_THRESHOLD_MYR = 100_000_000;
```

Extend `creditsValid` with `n <= MAX_CREDITS_MYR`, and the threshold check
with `t <= MAX_THRESHOLD_MYR` (each with an error string naming the cap,
matching the existing error-string style at `:201-203`).

In `vip-levels-validate-client.ts`, add the same mirrored
`MAX_VOUCHER_MYR = 10_000` and extend the voucher check with
`v <= MAX_VOUCHER_MYR` (error: `Level ${level}: voucher amount must be between 0 and 10,000.` —
match the file's existing message style).

**Verify**: build/typecheck exits 0.

### Step 2: Fix the three stale comments

1. Replace `challenge/page.tsx:194`'s sentence with one stating the client
   mirrors the server caps from plan 044.
2. Rewrite `ledger/page.tsx:27-30` to name **RF alone** as writerless
   (Epic 6 cancelled) and WP as written by `settleChallengeWinner` (plan 060).
3. Rewrite `vip-levels-validate-client.ts:1-3` to drop the Vouchers-tab
   reference (mirror of `modules/packs/vip-levels-validate.ts`, surfaced
   inline on the Levels tab).

**Verify**: `grep -n "plan 044) would slot in" backend/apps/admin/src/routes/challenge/page.tsx` → no match;
`grep -n "no writer produces them yet" backend/apps/admin/src/routes/ledger/page.tsx` → no match;
`grep -n "Vouchers tab" backend/apps/admin/src/routes/daily-rewards/vip-levels-validate-client.ts` → no match.

### Step 3: Format the credits total

`challenge/page.tsx:333`: import `rm` from `../../lib/format` (check the
file's existing import style/path) and render
`` `${rm(creditTotal)} credits` `` instead of `` `RM ${creditTotal} credits` ``
(`rm()` supplies the `RM` prefix — verify against `lib/format.ts` before
assuming; if it doesn't, keep the prefix).

**Verify**: build exits 0.

### Step 4: Tests

Locate colocated specs: `ls backend/apps/admin/src/routes/daily-rewards/*.test.ts
backend/apps/admin/src/routes/challenge/*.test.ts backend/apps/admin/src/lib/__tests__ 2>/dev/null`
and `grep -rln "vip-levels-validate-client\|creditsValid" backend/apps/admin/src --include=*.test.*`.
If a spec covers either validator, add over-cap rejection cases (10_001 fails,
10_000 passes; threshold 100_000_001 fails). If neither validator has a spec,
add one for `vip-levels-validate-client.ts` (it exports a pure function),
modeled on the nearest existing vitest file under `backend/apps/admin/src`.

**Verify**: `corepack yarn test` → all pass including the new cases.

## Test plan

Covered in Step 4: boundary pairs at each cap for both validators.

## Done criteria

- [ ] Client rejects credits/voucher > 10,000 and thresholds > 100,000,000
      inline, with per-row error strings
- [ ] Three stale comments gone (greps in Step 2)
- [ ] Credits total renders through `rm()`
- [ ] Admin build + vitest green
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- Server cap constants differ from 10,000 / 100,000,000 at execution time —
  re-read `voucher-ranges.ts:11` and `challenge-validate.ts` and mirror the
  ACTUAL values; if they moved, also flag that the mirror-drift class needs
  its parity guard (see Maintenance).
- The challenge page's validation isn't structured as excerpted (drift).

## Maintenance notes

- This is the mirror-drift class (plans 005/041 history). The literals here
  are now the 4th and 5th COUPLED MIRROR sites; if a 6th appears, build the
  source-parsing parity test (`src/lib/__tests__/buyback-parity.test.ts` is
  the pattern) for the admin app too — deferred because the admin app has no
  precedent for reading backend sources from its vitest run and the caps
  change rarely.
- Reviewer: confirm the client error strings name the caps so the operator
  learns the ceiling from the inline error, not the 400.
