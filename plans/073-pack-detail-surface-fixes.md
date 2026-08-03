# Plan 073: Pack-detail surface — honor `?count=`, never render a sibling pack under stale data, dedupe the pool labels, harden the QA script

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- "src/app/slots/[slug]/page.tsx" "src/app/slots/[slug]/PackDetailClient.tsx" "src/app/slots/[slug]/PoolByRarity.tsx" src/app/slots/CatalogClient.tsx src/lib/use-pack-detail-poll.ts src/lib/use-drag-scroll.ts scripts/qa-pool-modal.mjs`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (five small independent fixes on one surface)
- **Risk**: LOW–MED (73-B changes what renders during a sibling-switch failure; the empty states are already supported)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

Five defects on the pack-detail funnel surface (`/slots/[slug]`), the page a
customer reads immediately before spending:

- **A.** The desktop catalog stepper builds `/slots/<id>?count=N`, but the
  detail page never reads `count` — the stepper is a dead control and the URL
  lies about page state.
- **B.** Switching to a sibling pack seeds the live-detail poll with the _URL_
  pack's server snapshot; if the corrective fetch fails, pack A's pool, Top
  Hits, and published odds render permanently under pack B's name and price —
  a money-adjacent surface asserting the wrong odds.
- **C.** `PoolByRarity` derives the same "Rare & above"/"All cards" label four
  independent times (plus two hard-coded copies in the QA script) — the exact
  drift PR #320 set out to close.
- **D.** `useDragScroll` never resets on `pointercancel`/lost capture — an
  OS-cancelled drag leaves the rail scrolling on bare mouse moves.
- **E.** `scripts/qa-pool-modal.mjs` (PRs #321/#322) always exits 0, and its
  zero-Rare skip guard accepts any empty rail — a rail regression reads as a
  green "skipped" line and ends that viewport's loop.

## Current state

**A — the dropped param.**
`src/app/slots/CatalogClient.tsx:16-17`:

```ts
const packHref = (id: string, qty: number) =>
  `/slots/${encodeURIComponent(id)}?count=${qty}`;
```

`src/app/slots/[slug]/page.tsx:27-38` takes `params` only — no
`searchParams`. `PackDetailClient.tsx:67`: `const [qty, setQty] = useState(1);`.
The sibling route already implements the read+clamp —
`src/app/slots/[slug]/spin/page.tsx:32-37`:

```ts
  searchParams: Promise<{ count?: string; demo?: string }>;
...
  const { count: countRaw, demo } = await searchParams;
  const parsed = Number(countRaw);
  const count = Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : 1;
```

**B — the wrong-pack seed.** `PackDetailClient.tsx:74`:

```ts
const liveDetail = usePackDetailPoll(active.id, detail) ?? detail;
```

`active` is the user-selected sibling; `detail` is the URL pack's snapshot.
`src/lib/use-pack-detail-poll.ts:23-27` resets to that wrong seed on switch:

```ts
const [prevSlug, setPrevSlug] = useState(slug);
if (prevSlug !== slug) {
  setPrevSlug(slug);
  setDetail(initial);
}
```

and the corrective tick keeps last-good on failure (`:40` `if (!res.ok) return;`,
`:43-45` catch). The hook's own docstring (`:8-12`) admits the wrong-pack
window. Empty is a supported render state downstream (`PackDetailClient.tsx`
gates: pool on `pool.length > 0`, topHits on `topHits.length > 0`,
`publishedRows` null-gate).

**C — the label duplication.** `src/app/slots/[slug]/PoolByRarity.tsx:54-86`
computes `hasRail`, then derives the label/blurb/aria-label in four places:

```ts
const shown = hasRail ? rail : full;
const shownTitle = hasRail ? 'Rare & above' : 'All cards';
...
<h2 ...>{hasRail ? 'Rare & above' : 'All cards'}</h2>
...
aria-label={ hasRail
  ? `Show the ${shown.length} Rare & above cards grouped by rarity`
  : `Show all ${shown.length} cards grouped by rarity` }
...
<p ...>{hasRail
  ? 'The Rare-and-up cards available in this pack.'
  : 'Every card in this pack.'}</p>
```

**D — the missing cancel reset.** `src/lib/use-drag-scroll.ts:49-51`:

```ts
onPointerUp: () => {
  state.current.down = false;
},
```

No `onPointerCancel` / `onLostPointerCapture`; `onPointerMove` scrolls
whenever `s.down`.

**E — the QA script.** `scripts/qa-pool-modal.mjs:135-147`:

```js
const rail = page.locator('div.cursor-grab').first();
if ((await page.locator('div.cursor-grab').count()) === 0) {
  console.log(JSON.stringify({ slug, label,
    drag: 'skipped: no rail (zero-Rare "All cards" fallback)' }));
  done = true;
  await page.close();
  continue;
}
```

Nothing verifies the zero-Rare _diagnosis_ (the `h2` locator at `:47-49`
matches either heading but the matched text isn't captured), `done = true`
ends the viewport's slug loop, and every assertion (`dragScrolls`,
`clickStillWorks`, `escStack`, `scrollable`) is only `console.log`ged — the
process always exits 0. The script is manual-only by design
(`scripts/README.md`), which caps but does not remove the cost.

## Commands you will need

| Purpose                            | Command                          | Expected                         |
| ---------------------------------- | -------------------------------- | -------------------------------- |
| Storefront check                   | `npm run check`                  | exit 0 (lint+typecheck+build)    |
| Unit tests                         | `npm test`                       | all pass                         |
| QA script (manual, stack on :4000) | `node scripts/qa-pool-modal.mjs` | exit 0 only when all probes pass |

## Scope

**In scope**:

- `src/app/slots/[slug]/page.tsx`, `PackDetailClient.tsx`, `PoolByRarity.tsx`
- `src/lib/use-pack-detail-poll.ts`, `src/lib/use-drag-scroll.ts`
- `scripts/qa-pool-modal.mjs`
- New test file for the poll hook (see Test plan)

**Out of scope**:

- `src/app/slots/CatalogClient.tsx` — the producer is correct. (The mobile
  `PackRow` hard-coding qty 1 belongs to plan 057 #29, not here.)
- The Rare+-dialog vs full-pool-odds display split — **operator decision,
  recorded in-code** at `PoolByRarity.tsx:18-24` and
  `PackDetailClient.tsx:502-514`. Do not "fix" one side.
- `spin/page.tsx` (already correct), `use-modal-a11y.ts` (plan 075's file).

## Git workflow

- Branch: `advisor/073-pack-detail-surface`
- Conventional commits, one per lettered fix (e.g. `fix(pack): read ?count= on the detail page`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (A): Read and clamp `?count=` on the detail page

Mirror `spin/page.tsx:32-37` in `slots/[slug]/page.tsx`: add the
`searchParams` prop, clamp with the identical expression, pass
`initialQty={count}` to `PackDetailClient`. In `PackDetailClient`, add
`initialQty?: number` (default 1) and seed `useState(initialQty)`.
The page is already `dynamic = 'force-dynamic'`, so reading `searchParams`
costs nothing extra.

**Verify**: `npm run check` → exit 0.

### Step 2 (B): Reset the poll to empty — never to the wrong pack's snapshot

Change the seed contract so `initial` is only ever the matching pack's data:
in `PackDetailClient.tsx:74`, pass the snapshot only when the selected pack
IS the URL pack, and drop the `?? detail` fallback (it re-introduces the
wrong-pack data the hook change removes):

```ts
const liveDetail = usePackDetailPoll(
  active.id,
  active.id === pack.id ? detail : null,
);
```

In `use-pack-detail-poll.ts`, the reset branch then needs no change in shape
(`setDetail(initial)` with a null `initial` now clears correctly on switch) —
but update the docstring: the wrong-pack window is gone; a sibling switch
renders the gated-empty sections until the immediate tick lands.

Check all callers: `grep -rn "usePackDetailPoll" src/` — if any caller other
than `PackDetailClient.tsx` exists, STOP and report.

**Verify**: `npm run check` → exit 0; `npm test` → pass (plus the new hook
test below).

### Step 3 (C): One derivation for the pool label

In `PoolByRarity.tsx`, compute a single view object where `hasRail` is
currently read, and use it everywhere (h2, aria-label template, blurb,
`shown`/`shownTitle`, and the `PoolModal` title prop):

```ts
const view = hasRail
  ? {
      title: 'Rare & above',
      blurb: 'The Rare-and-up cards available in this pack.',
      cards: rail,
    }
  : { title: 'All cards', blurb: 'Every card in this pack.', cards: full };
```

Keep the rendered strings byte-identical (the QA script and any snapshots
key on them).

**Verify**: `npm run check` → exit 0; rendered output unchanged
(`grep -c "Rare & above" "src/app/slots/[slug]/PoolByRarity.tsx"` → 1).

### Step 4 (D): Reset the drag state on cancel

In `use-drag-scroll.ts`, alongside `onPointerUp`, add:

```ts
onPointerCancel: () => {
  state.current.down = false;
},
onLostPointerCapture: () => {
  state.current.down = false;
},
```

(They spread onto the rail with the rest of the handlers — confirm the
return-object type still typechecks.)

**Verify**: `npm run check` → exit 0.

### Step 5 (E): Make the QA script fail-closed

In `scripts/qa-pool-modal.mjs`:

1. Capture the matched heading text from the `h2` locator; accept the
   zero-Rare skip **only when it is exactly `All cards`** — otherwise record
   a failure (a missing rail under a `Rare & above` heading is a regression,
   not a fallback).
2. Do not set `done = true` on a skip — let the loop try the next slug.
3. Accumulate every probe boolean (`scrollable`, `dragScrolls`,
   `clickStillWorks`, the esc-stack counts) and set `process.exitCode = 1`
   when any is false, so the script cannot exit green on a regression.

**Verify**: `node --check scripts/qa-pool-modal.mjs` → exit 0. If the stack
is running: `node scripts/qa-pool-modal.mjs` → exit 0 with all probes true.

## Test plan

- New `src/lib/__tests__/use-pack-detail-poll.test.ts` (vitest + jsdom;
  model the hook-testing setup on any existing hook test under
  `src/lib/__tests__/`, or use `@testing-library/react`'s `renderHook` if
  present — if no hook-test harness exists in the repo, test the reset logic
  by extracting it, or fall back to a component-free assertion that the seed
  contract holds; do NOT add a new testing dependency). Cases: (1) initial
  non-null seed renders; (2) slug switch with `initial=null` yields `null`
  (not the old pack's data); (3) failed fetch after a switch stays `null`.
- Existing suites: `npm test` fully green.

## Done criteria

- [ ] Detail page reads `?count=` (clamped 1–3) and seeds the stepper
- [ ] `usePackDetailPoll` can no longer render pack A's data under pack B (no `?? detail` fallback; seed null on sibling)
- [ ] `grep -c "Rare & above" PoolByRarity.tsx` → 1
- [ ] `onPointerCancel`/`onLostPointerCapture` reset `down`
- [ ] `qa-pool-modal.mjs` sets a nonzero exit code on any failed probe and only skips drag when the heading is `All cards`
- [ ] `npm run check` and `npm test` exit 0
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- Any "Current state" excerpt doesn't match (drift — #320-#322 area is fresh).
- `usePackDetailPoll` has a second caller.
- The Step-2 change makes a section render _fabricated_ placeholder content
  instead of the gated-empty state — the gates listed under Current state
  must exist as described; if they don't, report.
- No viable hook-test harness and no clean extraction for the poll reset —
  report rather than adding a dependency.

## Maintenance notes

- If a shareable "pool view" type emerges (Step 3's object), the QA script's
  two hard-coded heading literals could import from a tiny constants module —
  deferred (script is ESM-on-node, storefront is TS; not worth a build step).
- Reviewer: check Step 2 renders acceptably on a slow connection (sibling
  click → brief empty pool → correct pool); this is the intended trade
  against showing the wrong pack's odds.
- Plan 057 #29 (mobile PackRow quantity) remains open and now composes with
  Step 1's `initialQty`.
