# Plan 100: Stop labeling MIX and non-PSA-10 graded packs as "Raw Cards (Ungraded)"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- src/app/slots/CatalogClient.tsx src/lib/packs-data.ts src/lib/__tests__/catalog-group.test.ts`
> On drift, compare "Current state"; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: trust / copy
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

PR #443 splits the catalog into exactly two sections: "Graded (Guaranteed
PSA 10)" and "Raw Cards (Ungraded)", where the second bucket is defined as
_everything that fails the guarantee_. The guarantee side is correctly
conservative (backed by real per-pack pool composition; degraded shapes fall
out of it — good). But the catch-all's heading makes its own false claim: a
pack whose pool is 100% graded PSA 9 slabs, or a mixed pool, is published to
paying customers as "Raw Cards (Ungraded)". `packs-data.ts`'s comment shows
this was a deliberate never-overclaim-the-guarantee design — the fix must keep
that direction (nothing may move INTO the guarantee bucket) while making the
second heading claim nothing that can be false. The data to do better is
already parsed and on the wire (`group: 'GRADED' | 'RAW' | 'MIX' | null`).

## Current state

- `src/app/slots/CatalogClient.tsx:241-254` — the two-bucket `GROUPS` const:

```ts
const GROUPS = [
  {
    id: 'graded',
    heading: 'Graded',
    note: 'Guaranteed PSA 10',
    Icon: ShieldCheck,
  },
  {
    id: 'raw',
    heading: 'Raw Cards',
    note: 'Ungraded',
    Icon: RectangleVertical,
  },
] as const;
```

- `CatalogClient.tsx:286-289` — the split:

```ts
const byGroup = {
  graded: entries.filter((e) => inGuaranteedGroup(e.pack)),
  raw: entries.filter((e) => !inGuaranteedGroup(e.pack)),
} as const;
```

- `src/lib/packs-data.ts:64-69` — the membership rule + its deliberate
  direction (the comment to preserve and extend):

```ts
/** Membership rule for the catalog's "Graded (Guaranteed PSA 10)" section —
 *  BOTH gates: every pooled card graded AND every one a PSA 10. Everything
 *  else (RAW, MIX, empty, non-PSA-10 graded, older backend) lists under
 *  "Raw Cards (Ungraded)" so the guarantee heading can never overclaim. */
export const inGuaranteedGroup = (p: Pack): boolean =>
  p.group === 'GRADED' && p.psa10 === true;
```

- `src/lib/data/schemas.ts:74-86` — `group` (`'GRADED'|'RAW'|'MIX'`, nullable,
  `.catch(null)`, optional) and `psa10` (`.catch(false)`) already parsed per
  pack row. Backend derivation is shared (`card-view.ts compositionGroup`) —
  GRADED iff every pooled card graded, RAW iff none, MIX otherwise, null for
  empty.
- `src/lib/__tests__/catalog-group.test.ts` — pins PSA-9-poisoned GRADED and
  MIX packs landing OUTSIDE the guarantee (`:26-36`), plus degraded shapes.
- Empty-section handling: `CatalogClient.tsx:345-352` skips empty sections —
  keep that behavior for the new third section.

### Target design (decided here)

Three sections, membership in this order (first match wins), never moving
anything INTO the guarantee bucket:

1. `graded` — heading "Graded", note "Guaranteed PSA 10" — unchanged:
   `inGuaranteedGroup(pack)`.
2. `raw` — heading "Raw Cards", note "Ungraded" — now TRUE by construction:
   `pack.group === 'RAW'`.
3. `more` — heading "More Packs", note "Mixed & graded pools" — everything
   else (`MIX`, non-PSA-10 `GRADED`, `null`/empty, older-backend degraded).
   The note claims only what is true of the whole bucket; if you can find a
   tighter honest note, fine, but it must be true for a degraded older-backend
   row too — when in doubt use no note (`note: ''` renders nothing? check the
   render site; if the note node is unconditional, keep the neutral wording).

Icon for `more`: reuse `RectangleVertical` unless another already-imported
lucide icon is obviously better; do not add imports beyond one lucide icon.

## Commands you will need

| Purpose | Command           | Expected                                   |
| ------- | ----------------- | ------------------------------------------ |
| Tests   | `npm test` (root) | all pass incl. updated catalog-group tests |
| Check   | `npm run check`   | exit 0                                     |

## Scope

**In scope**:

- `src/app/slots/CatalogClient.tsx` (GROUPS + byGroup + section render loop)
- `src/lib/packs-data.ts` (a new `catalogGroupOf(pack): 'graded'|'raw'|'more'`
  helper NEXT TO `inGuaranteedGroup`, so the membership rule stays in the
  tested lib, not inline in the component; keep `inGuaranteedGroup` exported
  and byte-identical — other call sites may use it)
- `src/lib/__tests__/catalog-group.test.ts` (extend)
- `scripts/qa-catalog-groups.mjs` — ONLY if it hardcodes the two headings
  (read it; update the expected-headings list if so, nothing else)

**Out of scope**:

- Backend `compositionGroup` / `poolComposition` — shared derivation, correct.
- `schemas.ts` — the parsed shape already carries everything needed.
- Pack detail pages, admin.

## Git workflow

- Branch: `advisor/100-catalog-label-truth`
- Conventional commit, e.g. `fix(storefront): stop labeling mixed/non-PSA10 pools as Ungraded`.
- No push/PR without operator instruction.

## Steps

### Step 1 (RED): extend the membership tests

In `catalog-group.test.ts`, add cases for the new `catalogGroupOf`:

1. `group:'GRADED', psa10:true` → `'graded'`
2. `group:'RAW'` → `'raw'`
3. `group:'MIX'` → `'more'`
4. `group:'GRADED', psa10:false` (the PSA-9 pool) → `'more'` — the headline
   case: it must NOT be `'raw'`
5. `group:null` / absent (older backend, empty pool) → `'more'`

**Verify**: fails (helper doesn't exist).

### Step 2 (GREEN): the helper + three sections

Implement `catalogGroupOf` in `packs-data.ts` (extend the existing comment
block: the guarantee still never overclaims; "Raw Cards (Ungraded)" now claims
only backend-derived all-raw pools; everything uncertain lands in the
claim-free bucket). Rewire `CatalogClient.tsx`: three-entry `GROUPS`, `byGroup`
built from `catalogGroupOf`, render loop unchanged otherwise (empty sections
already skip).

**Verify**: Step 1 cases pass; `npm test` green; `npm run check` exit 0.

### Step 3: QA script sweep

Read `scripts/qa-catalog-groups.mjs`. If it asserts the two-section structure
or heading texts, update its expectations to the three-section truth (and
nothing else). If plan 099 has landed, this script runs in the nightly — note
that in your README row update.

**Verify**: `node --check scripts/qa-catalog-groups.mjs` → exit 0 (syntax
only, unless a live stack is available for a full run).

## Test plan

Step 1's five cases (pattern: the existing cases in the same file). Existing
degraded-shape cases must stay green unchanged — they pin the guarantee gate,
which this plan does not touch.

## Done criteria

- [ ] `grep -n "Ungraded" src/app/slots/CatalogClient.tsx src/lib/packs-data.ts` → appears only where every member is backend-derived RAW
- [ ] `catalogGroupOf` exists in `packs-data.ts` with the 5 new tests green
- [ ] `inGuaranteedGroup` unchanged (`git diff` shows no edit to its body)
- [ ] `npm test` + `npm run check` green
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- The render site cannot skip a note (unconditional node) AND no honest note
  exists for the `more` bucket — report the render constraint instead of
  shipping a false one.
- `inGuaranteedGroup` has other call sites whose behavior would change
  (grep before editing; there should be exactly the catalog + tests).
- `qa-catalog-groups.mjs` encodes assumptions beyond headings (e.g. exactly-two
  sections structurally) that need more than an expectations edit.

## Maintenance notes

- If the operator later wants a true "Mixed" section separate from
  "non-PSA-10 graded", `group` already distinguishes them — split `more` then;
  the helper is the single place.
- Reviewer: verify no pack can appear in two sections and none can disappear
  (the three buckets must partition; Step 1 case 5 pins the null shape).
