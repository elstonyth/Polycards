# Reel Idle-Strip Randomization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each slot reel idles on its own randomly shuffled Pokémon order, reshuffled on every page visit and after every spin — without touching winner selection, landing physics, the seamless press-launch (#147), or the win-rate lock.

**Architecture:** One new pure helper (`shuffleCells`, Fisher–Yates) in `src/lib/hreel.ts`. `SlotMachineClient` replaces its single memoized decoy pool with per-reel shuffled pool state, randomized by a single `phase === 'idle'` effect (covers mount + return-to-idle + reel-count sync). `SlotReelStack` passes pool `i` to strip `i`. `ReelStrip` and all physics are untouched.

**Tech Stack:** Next.js 16 / React 19 / TypeScript strict, Vitest for unit tests, Playwright one-off QA scripts against the standalone prod server.

**Spec:** `docs/superpowers/specs/2026-07-14-reel-idle-randomization-design.md` (approved 2026-07-14).

## Global Constraints

- TypeScript strict, no `any`; named exports; 2-space indent (repo style).
- Branch: work on `reel-idle-randomization` (already created off `origin/master`). Conventional-commit messages.
- DO NOT modify: `src/app/slots/[slug]/ReelStrip.tsx`, `src/lib/vault-reel.ts`, winner-selection code, `buildHReelStrip`/`buildPressStrip` logic.
- Verify visuals against the **standalone prod server** (`pwsh scripts/serve-standalone.ps1 -Port 4000`), never `next dev`, never Chrome MCP — Playwright scripts only, screenshots to `docs/research/`.
- The repo's PostToolUse/Stop hooks type-check every edit; leave them green.
- Spec/plan docs are committed (docs/ became tracked mid-branch via 2df9a343); code and `scripts/*.mjs` are committed as always.

---

### Task 1: `shuffleCells` pure helper (TDD)

**Files:**
- Modify: `src/lib/hreel.ts` (add one exported function, after `buildDecoyPool`, around line 57)
- Test: `src/lib/__tests__/hreel.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: existing `HReelCell` type (`{ dex: number; rarity: Rarity }`) from `src/lib/hreel.ts`.
- Produces: `shuffleCells(cells: readonly HReelCell[], rand?: () => number): HReelCell[]` — Task 2 imports this from `@/lib/hreel`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/hreel.test.ts`. Add `shuffleCells` and `type HReelCell` to the existing `@/lib/hreel` import at the top of the file:

```ts
import {
  HREEL_STRIP_LEN,
  HREEL_WIN_INDEX,
  DECOY_DEXES,
  decoyRarity,
  teaseRarity,
  buildHReelStrip,
  buildPressStrip,
  buildDecoyPool,
  shuffleCells,
  type HReelCell,
} from '@/lib/hreel';
```

Then append at the end of the file:

```ts
describe('shuffleCells', () => {
  // Tiny deterministic LCG so tests never depend on Math.random.
  const seededRand = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  const pool: HReelCell[] = [
    { dex: 1, rarity: 'Common' },
    { dex: 4, rarity: 'Rare' },
    { dex: 7, rarity: 'Mythical' },
    { dex: 25, rarity: 'Immortal' },
    { dex: 143, rarity: 'Uncommon' },
    { dex: 130, rarity: 'Legendary' },
  ];
  const key = (c: HReelCell) => `${c.dex}:${c.rarity}`;

  test('preserves length and multiset (same cells, reordered)', () => {
    const out = shuffleCells(pool, seededRand(42));
    expect(out).toHaveLength(pool.length);
    expect(out.map(key).sort()).toEqual(pool.map(key).sort());
  });

  test('does not mutate its input', () => {
    const copy = pool.map((c) => ({ ...c }));
    shuffleCells(pool, seededRand(7));
    expect(pool).toEqual(copy);
  });

  test('is deterministic under an injected rng', () => {
    const a = shuffleCells(pool, seededRand(123));
    const b = shuffleCells(pool, seededRand(123));
    expect(a).toEqual(b);
  });

  test('actually reorders (some seed produces a different order)', () => {
    const orders = [1, 2, 3, 4, 5].map((s) =>
      shuffleCells(pool, seededRand(s)).map(key).join('|'),
    );
    const original = pool.map(key).join('|');
    expect(orders.some((o) => o !== original)).toBe(true);
  });

  test('handles empty and single-element pools', () => {
    expect(shuffleCells([], seededRand(1))).toEqual([]);
    expect(shuffleCells([pool[0]!], seededRand(1))).toEqual([pool[0]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/__tests__/hreel.test.ts`
Expected: FAIL — `shuffleCells` is not exported (`SyntaxError`/`TypeError: shuffleCells is not a function`). The pre-existing tests in the file must still pass.

- [ ] **Step 3: Implement `shuffleCells`**

In `src/lib/hreel.ts`, insert after the `buildDecoyPool` function (after its closing brace, ~line 57):

```ts
/**
 * Fisher–Yates copy-shuffle of a decoy pool — the per-idle-cycle strip
 * randomization (each reel tiles its OWN shuffled copy, reshuffled every time
 * the machine returns to idle, so the at-rest sequence is never the same
 * twice). `rand` is injectable for deterministic tests; defaults to
 * Math.random (only ever called from client effects, never during render).
 * Never mutates the input.
 */
export function shuffleCells(
  cells: readonly HReelCell[],
  rand: () => number = Math.random,
): HReelCell[] {
  const out = [...cells];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/__tests__/hreel.test.ts`
Expected: PASS (all pre-existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hreel.ts src/lib/__tests__/hreel.test.ts
git commit -m "feat(reel): add shuffleCells — pure Fisher-Yates decoy-pool shuffle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Per-reel shuffled pools wired through the client

**Files:**
- Modify: `src/app/slots/[slug]/SlotMachineClient.tsx:42` (import), `:150` (pool memo → state), after `:157` (effect), `:684` (prop)
- Modify: `src/app/slots/[slug]/SlotReelStack.tsx:31` (destructure), `:42-44` (prop type), `:100` (per-strip pass)

(Line numbers are pre-change anchors; nearby comments quoted below identify the sites exactly.)

**Interfaces:**
- Consumes: `shuffleCells` from Task 1; existing `buildDecoyPool`, `HReelCell` from `@/lib/hreel`.
- Produces: `SlotReelStack` prop `decoyPools?: readonly (readonly HReelCell[])[]` (replaces `decoyCards`). `ReelStrip`'s own `decoyCards?: readonly HReelCell[]` prop is UNCHANGED — `decoyPools?.[i]` (type `readonly HReelCell[] | undefined`) feeds it.

- [ ] **Step 1: Update the hreel import in SlotMachineClient**

Line 42, change:

```tsx
import { buildDecoyPool, type HReelCell } from '@/lib/hreel';
```

to:

```tsx
import { buildDecoyPool, shuffleCells, type HReelCell } from '@/lib/hreel';
```

- [ ] **Step 2: Replace the single pool memo with per-reel state**

At line 150 — directly below the existing "Decoy flicker pool:" comment block (keep that comment) — replace:

```tsx
  const decoyCards = useMemo<HReelCell[]>(() => buildDecoyPool(pool), [pool]);
```

with:

```tsx
  const basePool = useMemo<HReelCell[]>(() => buildDecoyPool(pool), [pool]);
  // Per-reel decoy pools: strip i tiles its OWN shuffled copy of basePool, so
  // stacked reels read independently and the idle sequence is never the same
  // twice (reshuffled per idle cycle — see the phase effect below). SSR-safe:
  // the initial value is the unshuffled pool, so server HTML matches the first
  // client paint; the shuffle lands one effect-tick after hydration.
  const [decoyPools, setDecoyPools] = useState<HReelCell[][]>(() =>
    Array.from({ length: reels }, () => basePool),
  );
```

(`reels` is already in scope — declared at line 135; `useState`/`useMemo` already imported.)

- [ ] **Step 3: Add the reshuffle effect**

Directly after `const [phase, setPhase] = useState<Phase>('idle');` (line 157), insert:

```tsx
  // Reshuffle every reel's decoy pool each time the machine goes idle: on
  // mount (post-hydration) and on every return-to-idle after a spin — the
  // same transition where ReelStrip snaps its position back to base, a cut
  // the reveal theater already covers. Pools stay frozen during
  // resolving/spinning, so buildPressStrip's keepCells always reproduce the
  // exact idle frame on screen at press time (#147 seamless launch).
  // Accepted trade-off (spec): adjusting the reel COUNT while idle reshuffles
  // all strips — cosmetic, coincides with the add/remove layout animation;
  // the alternative (stale pools array) would put non-pack Pokémon on a new
  // reel via the DECOY_DEXES fallback.
  useEffect(() => {
    if (phase !== 'idle') return;
    setDecoyPools(Array.from({ length: reels }, () => shuffleCells(basePool)));
  }, [phase, reels, basePool]);
```

- [ ] **Step 4: Pass the pools to the stack**

Line 684, change:

```tsx
                  decoyCards={decoyCards}
```

to:

```tsx
                  decoyPools={decoyPools}
```

- [ ] **Step 5: Update SlotReelStack's prop**

In `src/app/slots/[slug]/SlotReelStack.tsx`:

(a) Destructure (line 31): change `decoyCards,` to `decoyPools,`.

(b) Prop type (lines 42–44), replace:

```tsx
  /** Pack's own cards {dex, rarity} for the decoy flicker — the reel shows only
   *  the pack's Pokémon in only the pack's rarity colors. */
  decoyCards?: readonly HReelCell[];
```

with:

```tsx
  /** Per-strip decoy pools — pool `i` feeds strip `i` (each reel tiles its own
   *  shuffled copy of the pack pool, reshuffled per idle cycle, so stacked
   *  reels read independently). Cells are the pack's own {dex, rarity}. */
  decoyPools?: readonly (readonly HReelCell[])[];
```

(c) Per-strip pass (line 100): change `decoyCards={decoyCards}` to `decoyCards={decoyPools?.[i]}`.

- [ ] **Step 6: Lint, typecheck, unit tests**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: all green. (The PostToolUse hook will have type-checked each edit already; this is the explicit gate.)

- [ ] **Step 7: Commit**

```bash
git add "src/app/slots/[slug]/SlotMachineClient.tsx" "src/app/slots/[slug]/SlotReelStack.tsx"
git commit -m "feat(reel): per-reel shuffled idle strips, reshuffled per visit and per spin

Each reel idles on its own shuffleCells copy of the pack pool, re-randomized
by a single phase==='idle' effect (mount + return-to-idle + reel-count sync).
Winner selection, press-launch physics, and the win-rate lock untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Visual QA on the standalone prod server

**Files:**
- Create: `scripts/verify-reel-random.mjs` (one-off Playwright QA, repo convention)
- Output: `docs/research/reel-random-load-a.png`, `reel-random-load-b.png` (gitignored)

**Interfaces:**
- Consumes: the running storefront on `http://localhost:4000` (standalone build of the Task 2 code). Prereqs: `pokenic-postgres`/`pokenic-redis` docker containers up; backend `medusa develop` on :9000 (`corepack yarn dev` from `backend/packages/api`).
- Produces: pass/fail console output; screenshots for eyeball review.

- [ ] **Step 1: Write the verify script**

Create `scripts/verify-reel-random.mjs`:

```js
// scripts/verify-reel-random.mjs
// Verify the reel idle-strip randomization on the PROD build (:4000):
//   A. two fresh page loads show DIFFERENT idle Pokémon sequences;
//   B. after a guest demo spin auto-concludes back to idle, the strip is
//      reshuffled (differs from the same context's pre-spin sequence).
// Anonymous + ?demo=1 (guest-only demo) — no login needed.
// Run: node scripts/verify-reel-random.mjs   [QA_PACK=pokemon-elite]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const PACK = process.env.QA_PACK || 'pokemon-elite';

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

mkdirSync('docs/research', { recursive: true });
const browser = await chromium.launch({ headless: true });

// First reel strip's cell sprites, in strip order. The strip element is the
// only will-change-transform flex row inside the reel window (ReelStrip.tsx).
async function readStrip(page) {
  const strip = page.locator('div.will-change-transform').first();
  await strip.locator('img').first().waitFor({ timeout: 20000 });
  const srcs = await strip.locator('img').evaluateAll((imgs) =>
    imgs.slice(0, 12).map((el) => el.getAttribute('src') || ''),
  );
  return srcs.join('|');
}

async function freshLoad() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/slots/${PACK}?demo=1`, {
    waitUntil: 'domcontentloaded',
  });
  return { ctx, page };
}

try {
  // ── A: two fresh loads differ ─────────────────────────────────────────────
  const a = await freshLoad();
  const seqA = await readStrip(a.page);
  await a.page.screenshot({ path: 'docs/research/reel-random-load-a.png' });

  let b = await freshLoad();
  let seqB = await readStrip(b.page);
  if (seqB === seqA) {
    // Small pools can collide legitimately (poolLen! orders); one retry.
    await b.ctx.close();
    b = await freshLoad();
    seqB = await readStrip(b.page);
  }
  await b.page.screenshot({ path: 'docs/research/reel-random-load-b.png' });
  if (seqB !== seqA) ok('two fresh loads show different idle sequences');
  else fail('idle sequence identical across two loads (+1 retry)');
  await b.ctx.close();

  // ── B: post-spin return-to-idle reshuffles ────────────────────────────────
  const preSpin = await readStrip(a.page);
  const spinBtn = a.page.getByRole('button', { name: /spin/i }).first();
  await spinBtn.click();
  // Reveal auto-concludes to idle (#27) → the spin CTA re-enables.
  await a.page
    .waitForFunction(
      () => {
        const btns = [...document.querySelectorAll('button')];
        const spin = btns.find((el) => /spin/i.test(el.textContent || ''));
        return spin && !spin.disabled;
      },
      { timeout: 90000 },
    )
    .catch(() => fail('spin CTA never re-enabled (reveal did not conclude)'));
  const postSpin = await readStrip(a.page);
  if (postSpin !== preSpin) ok('return-to-idle reshuffled the strip');
  else fail('strip unchanged after the spin cycle');
  await a.ctx.close();
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'VERIFY: FAIL' : 'VERIFY: PASS');
```

- [ ] **Step 2: Build and serve the standalone bundle**

```powershell
# runaway-node guard first (repo lesson)
@(Get-Process node -ErrorAction SilentlyContinue).Count
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000   # run in background
```

Expected: build succeeds; :4000 serves. If the build crashes immediately with `Cannot read properties of undefined (reading 'length')`, that's the stale/server-held `.next` (repo lesson) — stop the serve-standalone server, `Remove-Item -Recurse -Force .next`, rebuild.

- [ ] **Step 3: Run the verify script + existing QA**

```bash
node scripts/verify-reel-random.mjs
node scripts/qa-demo-spin.mjs          # regression: demo flow still green
# if QA_SLOT_EMAIL/QA_SLOT_PASSWORD are set (seeded customer):
node scripts/qa-slot-machine.mjs       # regression: real spin still green
```

Expected: `VERIFY: PASS` with both ✓ lines; existing QA scripts keep their ✓ output. Then Read the two `docs/research/reel-random-load-*.png` screenshots and confirm by eye: different starting Pokémon under the payline, different neighbor order.

- [ ] **Step 4: Commit the QA script**

```bash
git add scripts/verify-reel-random.mjs
git commit -m "test(reel): Playwright verify for idle-strip randomization

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Done criteria

- `npm run test`, `npm run lint`, `npm run typecheck` green; Stop hook green.
- `verify-reel-random.mjs` passes on :4000 (fresh-load difference + post-spin reshuffle).
- `git diff origin/master --stat` touches only: `src/lib/hreel.ts`, `src/lib/__tests__/hreel.test.ts`, `SlotMachineClient.tsx`, `SlotReelStack.tsx`, `scripts/verify-reel-random.mjs`.
- `ReelStrip.tsx` / `vault-reel.ts` byte-identical to `origin/master`.
