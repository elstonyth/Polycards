# Plan 113: Make the free-pack gate's desktop badge checks satisfiable on any catalog size

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- scripts/qa-free-pack.mjs src/app/slots/CatalogClient.tsx`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

The nightly e2e workflow has been red for 9 consecutive nights (last green
2026-08-12). As of the 2026-08-19/20/21 runs the **only** failing step is
"Run free-pack QA gate", and inside it the **only** failing assertion is
`✗ desktop: no catalog tile parked under the badge` (verified from the
2026-08-21 run log; every Playwright spec and the other three gates are
green, and the gate's borrow/restore teardown from plan 107 works — the log
shows `✓ borrowed the free_welcome slot`, `✓ 'qa-free-welcome' set back to
draft`, `✓ restored 'free-welcome' to active`).

The failure is a **precondition mismatch, not a UI bug**: on desktop the
catalog renders as a _horizontal_ rail of fixed-width tiles, and the CI
database is a mirror of the production catalog with only 5 packs (plus the
QA free pack, which is excluded from `/store/packs`). Five tiles at
`lg:w-48` (192px) plus gaps end around x≈1050 at a 1440px viewport, while
the free-pack badge floats `fixed right-4` (its left edge ≈1200+). No tile
can ever share the badge's x-column at any scroll position, so the
park-a-tile-under-the-badge check fails by design ("FAILS rather than
falling back") — and the companion clearance check passes **vacuously**
with `✓ desktop: badge sits Infinitypx below the nearest control` because
zero tiles are on the badge's column at rest. Until this is fixed, the
nightly produces no signal for anything merged after 08-12.

## Current state

Files:

- `scripts/qa-free-pack.mjs` — the nightly free-pack QA gate (run as
  `npm run qa:free-pack` from `.github/workflows/e2e.yml`). The badge
  geometry block is lines ~370–486.
- `src/app/slots/CatalogClient.tsx` — the catalog page client component.
  The desktop layout is a horizontal scroll rail, NOT a grid.

Key excerpts as of `30eded61`:

`scripts/qa-free-pack.mjs:40`:

```js
const MIN_BADGE_GAP = 16;
```

`scripts/qa-free-pack.mjs:387-392` — the viewport loop and its rationale:

```js
  // 700px tall on desktop, not 900: at 900 this catalog fits without scrolling
  // and the badge floats over empty footer space, which would make the tap test
  // vacuous — a real (longer) catalog always has a card row on that rail.
  for (const [w, h, label] of [
    [375, 812, 'mobile'],
    [1440, 700, 'desktop'],
  ]) {
```

`scripts/qa-free-pack.mjs:429-451` — assertion (a), CLEARANCE. Note the
`Infinity` case: with zero on-rail tiles the gap is `Infinity`, which
**passes** `gap >= MIN_BADGE_GAP`:

```js
    await page.keyboard.press('End');
    await page.waitForTimeout(700);
    const badgeBox = await floating.boundingBox();
    const atRest = await scan();
    // Only tiles on the badge's own column can be fouled by it.
    const onRail = atRest.filter(
      (u) =>
        u.box.x < badgeBox.x + badgeBox.width &&
        badgeBox.x < u.box.x + u.box.width,
    );
    const gap = onRail.length
      ? Math.min(...onRail.map((u) => badgeBox.y - (u.box.y + u.box.height)))
      : Infinity;
    await shot(page, `badge-clearance-${label}`);
    if (gap >= MIN_BADGE_GAP) {
      ok(
        `${label}: badge sits ${Math.round(gap)}px below the nearest control at full scroll`,
      );
```

`scripts/qa-free-pack.mjs:453-468` — assertion (b), NO TAP SWALLOWING. This
is the line failing in CI:

```js
    // (b) NO TAP SWALLOWING — park a tile under the badge, then tap it.
    let nearest = null;
    let overlaps = false;
    for (let step = 0; step < 30 && !overlaps; step++) {
      const rows = await scan();
      nearest = rows.find((u) => u.overlap) ?? null;
      overlaps = Boolean(nearest);
      if (!overlaps) {
        await page.mouse.wheel(0, -90);
        await page.waitForTimeout(250);
      }
    }
    await shot(page, `badge-overlap-${label}`);
    if (!nearest) {
      fail(`${label}: no catalog tile parked under the badge`);
      continue;
    }
```

`src/app/slots/CatalogClient.tsx:297-306` — the catalog wrapper reserves
the badge's rail as bottom padding (this is what assertion (a) exists to
protect):

```tsx
      className={cn(
        ...
        freePack && 'pb-56 lg:pb-44',
      )}
```

`src/app/slots/CatalogClient.tsx:384-389` — the desktop tile row (per
section) is a horizontal overflow rail; tiles are fixed-width:

```tsx
            <div className="hidden gap-4 overflow-x-auto pb-2 sm:flex [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              ...
                  className="h-full w-44 shrink-0 lg:w-48"
```

`src/components/FreePackBadge.tsx:51` — the badge is fixed bottom-right,
16px from the right edge:

```tsx
'fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 block transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white lg:bottom-6';
```

Repo facts you need:

- The CI e2e job seeds a **mirror of the production catalog: 5 packs**
  (`tests/e2e` + `seed:e2e`; see `.github/workflows/e2e.yml`). Do not "fix"
  this by adding packs to the seed — the prod-mirror shape is deliberate
  (PR #451).
- The gate's philosophy (stated in its own comments at lines 380–385) is
  **fail loudly rather than pass vacuously**. Keep that: when a
  precondition cannot be met, the gate must FAIL with a message that says
  what to do, never silently skip.
- Tailwind's `lg` breakpoint is 1024px. Below 1024 the tiles shrink to
  `w-44` (176px); at ≥1024 they are `w-48` (192px). Keep the desktop leg's
  width ≥1024 so the measured geometry stays in the `lg` regime.
- `ok(...)` prints `✓` and `fail(...)` prints `✗` and marks the run failed;
  both are defined near the top of the script.

## Commands you will need

| Purpose               | Command                                              | Expected on success     |
| --------------------- | ---------------------------------------------------- | ----------------------- |
| Syntax check          | `node --check scripts/qa-free-pack.mjs`              | exit 0                  |
| Storefront typecheck  | `npm run typecheck`                                  | exit 0                  |
| Storefront unit tests | `npm test`                                           | all pass (622+ tests)   |
| Lint                  | `npm run lint`                                       | exit 0                  |
| Format                | `npm run format:check`                               | exit 0                  |
| Full gate locally     | `npm run qa:free-pack` (stack must be up, see below) | exits 0, every line `✓` |

Running the gate locally needs the full local stack (backend :9000 +
standalone storefront :4000 + seeded local DB). Use the repo's
`launching-pokenic-stack` skill if available in your environment; otherwise:
backend `corepack yarn dev` from `backend/packages/api`, storefront
`npm run build` then `pwsh scripts/serve-standalone.ps1 -Port 4000`. The
local dev DB has more than 5 packs — to reproduce the CI failure locally
you would need the 5-pack shape, which you cannot easily get; therefore the
local run proves "still passes on a long catalog" and the CI shape is
proven by the next nightly (see Done criteria).

## Scope

**In scope** (the only files you should modify):

- `scripts/qa-free-pack.mjs`
- `src/app/slots/CatalogClient.tsx` — ONE attribute only: add
  `data-testid="catalog-root"` to the wrapper element that carries the
  `freePack && 'pb-56 lg:pb-44'` classes (line ~297).

**Out of scope** (do NOT touch):

- `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` and anything
  else that shapes the CI catalog — the 5-pack prod mirror is deliberate.
- `src/components/FreePackBadge.tsx` — the badge's position is correct;
  this is a test-precondition fix, not a UI fix.
- `.github/workflows/e2e.yml` — the gate wiring is fine.
- The other qa-\*.mjs scripts (plan 120 owns those).

## Git workflow

- Branch: `advisor/113-free-pack-gate-desktop-precondition`
- Conventional commits, e.g. `fix(qa): make the free-pack badge checks satisfiable on a 5-pack catalog`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a stable testid to the catalog wrapper

In `src/app/slots/CatalogClient.tsx`, on the element whose `className`
includes `freePack && 'pb-56 lg:pb-44'` (line ~297), add
`data-testid="catalog-root"`. No other change.

**Verify**: `npm run typecheck` → exit 0.
`grep -n "catalog-root" src/app/slots/CatalogClient.tsx` → exactly 1 match.

### Step 2: Replace the geometric clearance assertion (a) with a computed-padding assertion

In `scripts/qa-free-pack.mjs`, replace the block from
`await page.keyboard.press('End');` (line ~429) through the end of the
gap `if/else` (line ~451) with a check that reads the reserved rail
directly — this is viewport- and catalog-size-independent, and it kills
the `Infinity` vacuous pass:

```js
// (a) RESERVED RAIL. CatalogClient reserves the badge's rail as bottom
// padding (`pb-56 lg:pb-44`, gated on the badge rendering). The old
// geometric gap check needed a tile on the badge's column at full
// scroll, which a short catalog (CI mirrors prod: 5 packs) never
// provides — so assert the padding itself, which is what the deleted-
// padding regression actually removes. pb-56 = 224px, pb-44 = 176px.
const minPad = label === 'desktop' ? 176 : 224;
const pad = await page
  .getByTestId('catalog-root')
  .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
if (pad >= minPad) {
  ok(
    `${label}: catalog reserves ${Math.round(pad)}px bottom rail for the badge (want >= ${minPad})`,
  );
} else {
  fail(
    `${label}: catalog bottom padding is ${Math.round(pad)}px (want >= ${minPad}) — the reserved badge rail is gone`,
  );
}
```

Keep the screenshot call (`await shot(page, `badge-clearance-${label}`)`)
if convenient, or drop it — the padding check does not need it. Delete the
now-unused `onRail`/`gap` computation and the `MIN_BADGE_GAP` constant if
nothing else references it (`grep -n "MIN_BADGE_GAP" scripts/qa-free-pack.mjs`
→ only the declaration left means delete it too).

**Verify**: `node --check scripts/qa-free-pack.mjs` → exit 0.

### Step 3: Make the desktop tap-swallow leg compute a viewport width the catalog can actually fill

The mobile leg is fine (full-width vertical list rows always reach the
badge column). For the desktop leg, before running the park-and-tap loop
(b), measure the geometry at 1440×700 and re-open at a width where the
badge's column intersects the rail's last tile:

Inside the `for (const [w, h, label] of …)` loop, after the badge is
visible and `scan()` is available, add for the desktop label only:

```js
    if (label === 'desktop') {
      // The desktop catalog is a fixed-width horizontal rail; a short
      // catalog (CI = 5 packs) ends left of the fixed bottom-right badge,
      // so no tile can ever intersect it at 1440. Measure the rail's right
      // edge and the badge box, then re-open at a width where the badge's
      // column overlaps the last tile by ~40px. Clamped to [1024, 1440] so
      // the lg tile geometry (w-48) is preserved.
      const initialRows = await scan();
      const railRight = Math.max(0, ...initialRows.map((u) => u.box.x + u.box.width));
      const bb = await floating.boundingBox();
      const rightOffset = w - (bb.x + bb.width); // ≈16 (right-4)
      const fitted = Math.floor(railRight + rightOffset + bb.width - 40);
      if (fitted < 1024) {
        // Self-diagnosing: print every input so a red nightly hands over the
        // numbers instead of costing another round (the trap that let plan
        // 107 ship red). If `fitted` is only just under 1024, the -40 overlap
        // margin is the knob; if railRight is tiny, the catalog is genuinely
        // too short.
        fail(
          `desktop: catalog too small to park a tile under the badge at any lg viewport ` +
            `(railRight=${Math.round(railRight)} rightOffset=${Math.round(rightOffset)} ` +
            `badgeW=${Math.round(bb.width)} fitted=${fitted}, need >=1024) — seed at least ~4 packs`,
        );
        continue;
      }
      if (fitted < w) {
        await page.setViewportSize({ width: fitted, height: h });
        await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
        await floating.waitFor({ state: 'visible', timeout: 20000 });
      }
    }
```

Place this AFTER the tiles locator and `scan` helper are defined and BEFORE
the (a) padding check from Step 2 (order within the loop: navigate →
measure/refit viewport → padding check → park-and-tap loop). The
park-and-tap loop (b) itself stays exactly as it is — with the viewport
refit, `fail('desktop: no catalog tile parked under the badge')` now only
fires on a real regression.

Note `scan()` uses the loop variables `w`/`h` for its on-screen filter — if
you refit the viewport, make sure the on-screen filter uses the CURRENT
viewport size (either update local `w` or read
`page.viewportSize()` inside `scan`). Simplest correct move: reassign
`w = fitted` before the goto (the loop destructuring gives you a mutable
binding only if you change `const [w, h, label]` to `let [w, h, label]` —
do that).

**Verify**: `node --check scripts/qa-free-pack.mjs` → exit 0.
`npm run lint` → exit 0. `npm run format:check` → exit 0 (run
`npm run format` first if it flags the new block).

### Step 4: Run the full gate against the local stack

Start the local stack (see Commands). Then:

`npm run qa:free-pack` → exit 0, and the output must contain, for BOTH
`mobile:` and `desktop:` labels:

- `✓ …: catalog reserves …px bottom rail for the badge`
- `✓ …: tile /slots/….?count=… opens on tap (badge overlap: true)`

The local catalog is longer than CI's, so the desktop `fitted` width will
usually be ≥1440 and the viewport refit will be a no-op — that is expected;
the refit exists for the CI shape.

**Verify**: gate exit code 0; paste the `✓`/`✗` lines into your report.

### Step 5: Mutation-prove both halves

1. Padding check: temporarily edit `src/app/slots/CatalogClient.tsx` to
   remove `freePack && 'pb-56 lg:pb-44'`, rebuild
   (`npm run build` + restart the standalone server), re-run the gate →
   the run must FAIL with
   `✗ …: catalog bottom padding is …px (want >= …)` on at least one
   viewport. **Revert the edit** and rebuild.
2. Tap check precondition: no cheap mutation exists without reshaping the
   catalog — skip, the CI nightly is the proof (see Done criteria).

**Verify**: the mutated run exits 1 with the expected `✗` line; after
revert, `git diff src/app/slots/CatalogClient.tsx` shows ONLY the
`data-testid` addition from Step 1.

## Test plan

This plan is itself a test change; the mutation proof in Step 5 is the
test-of-the-test. No vitest changes. Existing suite must stay green:
`npm test` → all pass.

## Done criteria

- [ ] `node --check scripts/qa-free-pack.mjs` exits 0
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` all exit 0
- [ ] Local `npm run qa:free-pack` exits 0 with the two `✓` lines per viewport listed in Step 4
- [ ] Step 5's padding mutation makes the gate exit 1, and the mutation is reverted
- [ ] `grep -c "Infinity" scripts/qa-free-pack.mjs` returns 0 (the vacuous-gap path is gone)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated
- [ ] **WATCH (post-merge, operator)**: the first nightly after this merges must show the free-pack gate green — that is the only place the 5-pack shape exists. If it fails on `desktop: catalog too small…`, the `fitted` clamp math is wrong for the real badge width; reopen this plan.

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift since `30eded61`).
- The local stack cannot be brought up after two attempts (report the boot
  error; do not ship the script change unexercised).
- The desktop `fitted` computation still cannot produce an overlap on the
  LOCAL catalog (would mean the badge box measurement is wrong — report
  the measured `railRight`, `rightOffset`, `bb.width`).
- You find yourself wanting to modify the e2e seed or the badge component.

## Maintenance notes

- If the production catalog grows past ~7 packs, the desktop refit becomes
  a permanent no-op and could be deleted — harmless either way.
- If CatalogClient's desktop layout changes from a horizontal rail to a
  grid, the refit is unnecessary but still correct (the measure adapts);
  the padding constants (176/224) must track any change to
  `pb-56 lg:pb-44`.
- Reviewer: scrutinize the `let [w, h, label]` mutation in Step 3 — the
  on-screen filter in `scan()` must see the refitted width, or off-screen
  tiles get scanned and the park loop can "find" an invisible tile.
