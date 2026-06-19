# Slot Machine v2 — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/slots/[slug]` into a full-screen immersive reveal with a vertical Pokémon-sprite reel that scrolls ↓, stops on a shared payline, and grows + glows the winner in its price-tier color — only after settle.

**Architecture:** Replace the v1 horizontal SVG-ball reel (`SlotReelRow` + `BallToken`) with vertical `SlotReelColumn`s composed by an N-capable `SlotReelStack` (driven at **count=1** in Phase B; the N-roll `open-batch` wiring is Phase D). Chrome (`SiteHeader`/`SiteFooter`) is suppressed by a **fixed full-screen overlay** plus a `useChromeInert` hook that marks the root chrome `inert` + `aria-hidden` — **no route-group folder move** (this supersedes spec §10/§14's route-group plan for Phase B). Win outcome stays 100% server-authoritative (`openPack`); the reel only displays `res.card`.

**Tech Stack:** Next.js 16 (App Router, React 19, TS strict), Tailwind v4, vitest 3 (pure-function unit tests), Playwright `.mjs` capture scripts against the prod standalone on `:4000`.

## Global Constraints

- TypeScript strict, **no `any`**; named exports; PascalCase components; 2-space indent. (AGENTS.md)
- Tailwind utility classes; the only inline `style` allowed is the existing CSS-variable pattern (`{ '--reel-y': … } as CSSProperties`). Use `px-fluid` for horizontal gutters. (CLAUDE.md)
- **Win-rate lock is untouched.** Outcome decided server-side by `openPack`; the reel never picks a winner. (spec §8)
- **Win-after-stop:** win banner / SFX / price / grow-glow / sell-back fire ONLY on the stack's final settle, never mid-scroll. (spec §4 bug #1)
- **No layout shift:** the reveal is a `fixed inset-0` surface; nothing reflows mid-spin. (spec §4 bug #2)
- **Phase B is single-roll, count=1.** Build the stack N-capable but drive it with one `openPack`. `?count=N` and `open-batch` are Phase D — do not consume `count` here.
- Reduced motion degrades every surface (no scroll/glow-pulse; winner centered + static glow). (spec §10)
- Verify on the **prod standalone `:4000`**, NOT `next dev`; verify with **Playwright `scripts/*.mjs`**, NOT Chrome MCP. (CLAUDE.md)
- Work in a fresh worktree branched off **master `e859757`**; run `npm install` in it before building. (handoff)
- `priceTier` reads the backend **`marketValue`** off the `openPack` result (NOT mock `fmv`/`price`). (spec §3, G3)

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `src/lib/reel.ts` | + `ITEM_H`, `STAGGER_MS`, `POKEDEX_MAX`, `reelTargetY`, `buildDexStrip` (vertical analogs; existing X-axis helpers kept) | Modify |
| `src/lib/__tests__/reel.test.ts` | + unit tests for `reelTargetY` and `buildDexStrip` | Modify |
| `src/lib/use-chrome-inert.ts` | hook: scroll-lock body + `inert`/`aria-hidden` on `[data-site-chrome]` while active | Create |
| `src/components/SiteHeader.tsx` | add `data-site-chrome` to root `<header>` | Modify |
| `src/components/SiteFooter.tsx` | add `data-site-chrome` to root `<footer>` | Modify |
| `src/app/slots/[slug]/PokemonToken.tsx` | + `eager?` and `imageSrc?` props (no behavior change otherwise) | Modify |
| `src/app/slots/[slug]/SlotReelColumn.tsx` | one vertical reel column (Y-translate, `PokemonToken` cells, winner grow+glow) | Create |
| `src/app/slots/[slug]/PaylineRow.tsx` | horizontal payline overlay (vertical-reel analog of `PaylineBeam`) | Create |
| `src/app/slots/[slug]/SlotReelStack.tsx` | N columns, shared payline, staggered L→R stop, `onAllSettled` after last | Create |
| `src/app/slots/[slug]/SlotMachineClient.tsx` | rewrite render → immersive overlay driving a count=1 stack | Modify |
| `src/app/slots/[slug]/SlotReelRow.tsx` · `BallToken.tsx` · `PaylineBeam.tsx` | dead after rewrite — remove (grep-gated) | Delete |
| `scripts/qa-slots-phaseB.mjs` | Playwright verify: idle → SPIN → settle, chrome inert, no shift | Create |
| `docs/superpowers/specs/2026-06-18-slot-machine-v2-design.md` · memory | record overlay-supersedes-route-group delta | Modify |

`SlotStatusBar`, `SlotControls`, `OddsSheet`, `SellBackPanel`, `useSound`, `usePrefersReducedMotion`, `priceTier`/`TIER_COLOR`, `pokemonFromCard`, `spriteGif` are reused **as-is**.

---

### Task 1: Vertical reel geometry + dex-strip builder

**Files:**
- Modify: `src/lib/reel.ts`
- Test: `src/lib/__tests__/reel.test.ts`

**Interfaces:**
- Consumes: existing `STRIP_LEN` (48), `WIN_INDEX` (36).
- Produces: `ITEM_H: number` (112), `STAGGER_MS: number` (260), `POKEDEX_MAX: number` (1025), `reelTargetY(winIndex, itemH, winHeight): number`, `buildDexStrip(winnerDex, length, winIndex): number[]`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/__tests__/reel.test.ts`, and extend the existing import on lines 2-8 to add `reelTargetY, buildDexStrip, ITEM_H, POKEDEX_MAX`:

```ts
describe('reelTargetY', () => {
  it('centers the winner index under a horizontal payline', () => {
    // 36*112 + 112/2 - 600/2 = 4032 + 56 - 300 = 3788
    expect(reelTargetY(36, 112, 600)).toBe(3788);
  });
  it('shifts up as the window grows taller (winner stays centered)', () => {
    expect(reelTargetY(36, 112, 800)).toBe(reelTargetY(36, 112, 600) - 100);
  });
  it('uses ITEM_H = 112 by default geometry', () => {
    expect(ITEM_H).toBe(112);
  });
});

describe('buildDexStrip', () => {
  it('pins the winner dex exactly at WIN_INDEX', () => {
    const strip = buildDexStrip(150, STRIP_LEN, WIN_INDEX);
    expect(strip).toHaveLength(STRIP_LEN);
    expect(strip[WIN_INDEX]).toBe(150);
  });
  it('keeps every cell within [1, POKEDEX_MAX]', () => {
    buildDexStrip(150, STRIP_LEN, WIN_INDEX).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(POKEDEX_MAX);
    });
  });
  it('clamps an out-of-range winner to dex 1', () => {
    expect(buildDexStrip(0, STRIP_LEN, WIN_INDEX)[WIN_INDEX]).toBe(1);
    expect(buildDexStrip(99999, STRIP_LEN, WIN_INDEX)[WIN_INDEX]).toBe(1);
  });
  it('is deterministic for the same inputs', () => {
    expect(buildDexStrip(25, STRIP_LEN, WIN_INDEX)).toEqual(
      buildDexStrip(25, STRIP_LEN, WIN_INDEX),
    );
  });
  it('throws when winIndex is out of bounds', () => {
    expect(() => buildDexStrip(25, STRIP_LEN, STRIP_LEN)).toThrow(RangeError);
    expect(() => buildDexStrip(25, STRIP_LEN, -1)).toThrow(RangeError);
  });
  it('throws when length is not a positive integer', () => {
    expect(() => buildDexStrip(25, 0, 0)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- reel`
Expected: FAIL — `reelTargetY`/`buildDexStrip`/`ITEM_H`/`POKEDEX_MAX` are not exported.

- [ ] **Step 3: Add the implementation** — append to `src/lib/reel.ts`:

```ts
/** Reel cell height in CSS px for the vertical reel (Phase B). */
export const ITEM_H = 112;
/** Per-column stop stagger (ms): column i stops at BASE_SPIN_MS + i*STAGGER_MS. */
export const STAGGER_MS = 260;
/** National-dex upper bound (matches POKEDEX_NAMES length). */
export const POKEDEX_MAX = 1025;

/**
 * Vertical analog of reelTarget: translate offset (px, positive) that centers
 * `winIndex` under a HORIZONTAL payline for a window `winHeight` px tall. Apply
 * as `translateY(-reelTargetY(...))`.
 */
export function reelTargetY(
  winIndex: number,
  itemH: number,
  winHeight: number,
): number {
  return winIndex * itemH + itemH / 2 - winHeight / 2;
}

/**
 * A fixed-length strip of national-dex numbers with `winnerDex` pinned at
 * `winIndex`. Decoy cells are spread deterministically with a prime step
 * (167 is co-prime with POKEDEX_MAX = 5²·41 → wide, repeat-free spread, and
 * deterministic so it is unit-testable). The v2 analog of `buildStrip`, over
 * dex numbers (sprites) instead of `Rarity`.
 */
export function buildDexStrip(
  winnerDex: number,
  length: number,
  winIndex: number,
): number[] {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('buildDexStrip: length must be a positive integer');
  }
  if (!Number.isInteger(winIndex) || winIndex < 0 || winIndex >= length) {
    throw new RangeError('buildDexStrip: winIndex must be within [0, length)');
  }
  const safeWinner =
    Number.isInteger(winnerDex) && winnerDex >= 1 && winnerDex <= POKEDEX_MAX
      ? winnerDex
      : 1;
  const strip = Array.from(
    { length },
    (_, i) => ((i * 167 + 13) % POKEDEX_MAX) + 1,
  );
  strip[winIndex] = safeWinner;
  return strip;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- reel`
Expected: PASS (existing `reelTarget`/`buildStrip` tests still green too).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reel.ts src/lib/__tests__/reel.test.ts
git commit -m "feat(slots): add vertical reel geometry + dex-strip builder (Phase B)"
```

---

### Task 2: PokemonToken — eager load + image override

**Files:**
- Modify: `src/app/slots/[slug]/PokemonToken.tsx`

**Interfaces:**
- Produces: `PokemonToken` gains optional `eager?: boolean` (default false) and `imageSrc?: string`. When `imageSrc` is set the cell renders it verbatim (the §2/G5 non-Pokémon card-art fallback) and skips the gif→png sprite fallback.

> Presentational change — covered by the Playwright pass in Task 8, no unit test (testing.md: visual components use Playwright).

- [ ] **Step 1: Add the two props** — edit the props type to add (after `reduced?: boolean;`):

```ts
  /** Eager-load this cell's image (winner + cells resting in the visible window). */
  eager?: boolean;
  /** Render this exact image instead of a dex sprite (non-Pokémon card fallback, §2/G5). */
  imageSrc?: string;
```

- [ ] **Step 2: Thread them through the body** — update the destructure and the `src` state + effect + `<img>`:

```tsx
export function PokemonToken({
  dex,
  name,
  tier,
  size = 96,
  landed = false,
  reduced = false,
  eager = false,
  imageSrc,
}: PokemonTokenProps) {
  const [src, setSrc] = useState(imageSrc ?? spriteGif(dex));
  // Re-sync if a recycled cell receives a new dex or image override.
  useEffect(() => {
    setSrc(imageSrc ?? spriteGif(dex));
  }, [dex, imageSrc]);
```

  and the `<img>` element:

```tsx
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        loading={eager ? 'eager' : 'lazy'}
        onError={() => {
          if (imageSrc) return; // no sprite fallback for a direct image override
          setSrc((s) => (s === spritePng(dex) ? s : spritePng(dex)));
        }}
        className="h-[80%] w-auto max-w-[80%] object-contain [image-rendering:auto]"
      />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/slots/[slug]/PokemonToken.tsx
git commit -m "feat(slots): PokemonToken eager-load + card-image override prop"
```

---

### Task 3: SlotReelColumn — one vertical reel

**Files:**
- Create: `src/app/slots/[slug]/SlotReelColumn.tsx`

**Interfaces:**
- Consumes: `reelTargetY`, `buildDexStrip`, `ITEM_H`, `STRIP_LEN`, `WIN_INDEX`, `REEL_EASE` (reel.ts); `spriteGif` (pokedex); `Tier` (price-tier); `PokemonToken` (Task 2).
- Produces: `SlotReelColumn` with props `{ winnerDex: number | null; winnerImage?: string; winnerName?: string; tier: Tier; reduced: boolean; durationMs: number; cellSize?: number; onSettled?: () => void }`. Idle when `winnerDex === null` **and** `winnerImage === undefined`.

> Animation component — verified in Task 8, no unit test.

- [ ] **Step 1: Create the file** with this exact content:

```tsx
// src/app/slots/[slug]/SlotReelColumn.tsx
'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { cn } from '@/lib/utils';
import {
  reelTargetY,
  buildDexStrip,
  ITEM_H,
  STRIP_LEN,
  WIN_INDEX,
  REEL_EASE,
} from '@/lib/reel';
import { spriteGif } from '@/lib/mock/pokedex';
import type { Tier } from '@/lib/price-tier';
import { PokemonToken } from './PokemonToken';

/** Window shows 5 cells; cells within this radius of WIN_INDEX eager-load. */
const VISIBLE_CELLS = 5;
const EAGER_RADIUS = 3;

/**
 * A vertical reel column that DISPLAYS a pre-decided winner (it never picks one,
 * spec §8). Idle and reduced motion land centered instantly; otherwise it
 * scrolls ↓ once on mount — remount (new key) to re-spin. The winner cell shows
 * the won Pokémon sprite, or `winnerImage` (card art) when the card has no
 * resolvable Pokémon (§2/G5). Win grow+glow only after settle.
 */
export function SlotReelColumn({
  winnerDex,
  winnerImage,
  winnerName,
  tier,
  reduced,
  durationMs,
  cellSize = 96,
  onSettled,
}: {
  winnerDex: number | null;
  winnerImage?: string;
  winnerName?: string;
  tier: Tier;
  reduced: boolean;
  durationMs: number;
  cellSize?: number;
  onSettled?: () => void;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const settled = useRef(false);

  const isWin = winnerDex !== null || winnerImage !== undefined;

  const strip = useMemo(
    () => buildDexStrip(winnerDex ?? 1, STRIP_LEN, WIN_INDEX),
    [winnerDex],
  );

  // Warm the landed image/sprite cache the moment a spin starts (≥ BASE_SPIN_MS
  // of scroll = ample fetch time) so the winner cell paints on settle.
  useEffect(() => {
    if (!isWin) return;
    const img = new Image();
    img.src = winnerImage ?? spriteGif(winnerDex ?? 1);
  }, [isWin, winnerImage, winnerDex]);

  useEffect(() => {
    settled.current = false;
    const winH = windowRef.current?.clientHeight ?? ITEM_H * VISIBLE_CELLS;
    const target = Math.round(reelTargetY(WIN_INDEX, ITEM_H, winH));

    // Idle: rest centered, no scroll, no settle callback.
    if (!isWin) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSpinning(false);
      setOffset(-target);
      return;
    }
    // Reduced motion: jump centered, fire settle next tick.
    if (reduced) {
      setSpinning(false);
      setOffset(-target);
      const id = setTimeout(() => {
        if (!settled.current) {
          settled.current = true;
          onSettled?.();
        }
      }, 0);
      return () => clearTimeout(id);
    }
    // Real spin: origin → centered winner, settle on transition end. Two nested
    // frames so the transition starts from the origin; cancel BOTH on teardown.
    setOffset(0);
    setSpinning(true);
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setOffset(-target));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isWin, reduced, onSettled]);

  return (
    <div
      ref={windowRef}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-neutral-950"
      style={{ height: `${ITEM_H * VISIBLE_CELLS}px`, width: `${cellSize + 24}px` }}
      aria-hidden
    >
      <div
        className={cn(
          'flex flex-col items-center [transform:translateY(var(--reel-y))]',
          spinning && '[transition:transform_var(--reel-dur)_var(--reel-ease)]',
        )}
        style={
          {
            '--reel-y': `${offset}px`,
            '--reel-dur': spinning ? `${durationMs}ms` : '0ms',
            '--reel-ease': REEL_EASE,
          } as CSSProperties
        }
        onTransitionEnd={() => {
          if (spinning && !settled.current) {
            settled.current = true;
            setSpinning(false);
            onSettled?.();
          }
        }}
      >
        {strip.map((dex, i) => {
          const isWinnerCell = i === WIN_INDEX;
          const landed = isWinnerCell && !spinning && isWin;
          return (
            <div
              key={i}
              className="flex shrink-0 items-center justify-center"
              style={{ height: `${ITEM_H}px` }}
            >
              <PokemonToken
                dex={dex}
                name={isWinnerCell ? (winnerName ?? '') : ''}
                tier={tier}
                size={cellSize}
                landed={landed}
                reduced={reduced}
                eager={Math.abs(i - WIN_INDEX) <= EAGER_RADIUS}
                imageSrc={isWinnerCell ? winnerImage : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/SlotReelColumn.tsx
git commit -m "feat(slots): vertical SlotReelColumn with winner grow+glow on settle"
```

---

### Task 4: PaylineRow + SlotReelStack

**Files:**
- Create: `src/app/slots/[slug]/PaylineRow.tsx`
- Create: `src/app/slots/[slug]/SlotReelStack.tsx`

**Interfaces:**
- Consumes: `STAGGER_MS` (reel.ts); `Tier` (price-tier); `SlotReelColumn` (Task 3).
- Produces:
  - `PaylineRow` props `{ reduced: boolean; pulse?: boolean }`.
  - `type ColumnWinner = { dex: number | null; image?: string; name?: string; tier: Tier }`.
  - `SlotReelStack` props `{ count: number; spinKey: string | number; winners: ColumnWinner[] | null; reduced: boolean; baseDurationMs: number; cellSize?: number; pulse?: boolean; onAllSettled?: () => void }`. `winners === null` ⇒ idle. `onAllSettled` fires once, after the LAST column settles.

> Verified in Task 8, no unit test.

- [ ] **Step 1: Create `PaylineRow.tsx`** (horizontal analog of `PaylineBeam`):

```tsx
// src/app/slots/[slug]/PaylineRow.tsx
import { cn } from '@/lib/utils';

/** Horizontal payline across the reel stack. `pulse` flashes on win (spec §3.4). */
export function PaylineRow({
  reduced,
  pulse = false,
}: {
  reduced: boolean;
  pulse?: boolean;
}) {
  return (
    <>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 right-0 top-1/2 z-10 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500 shadow-[0_0_24px_2px_rgba(168,85,247,0.7)]',
          !reduced && pulse && 'animate-pulse',
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2 border-y-[7px] border-l-[9px] border-y-transparent border-l-violet-400"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-1/2 z-10 -translate-y-1/2 rotate-180 border-y-[7px] border-l-[9px] border-y-transparent border-l-violet-400"
      />
    </>
  );
}
```

- [ ] **Step 2: Create `SlotReelStack.tsx`**:

```tsx
// src/app/slots/[slug]/SlotReelStack.tsx
'use client';

import { useCallback, useEffect, useRef } from 'react';
import { STAGGER_MS } from '@/lib/reel';
import type { Tier } from '@/lib/price-tier';
import { SlotReelColumn } from './SlotReelColumn';
import { PaylineRow } from './PaylineRow';

export type ColumnWinner = {
  dex: number | null;
  image?: string;
  name?: string;
  tier: Tier;
};

/**
 * N vertical reel columns sharing one horizontal payline. Columns stop staggered
 * L→R (column i stops at baseDurationMs + i*STAGGER_MS). `winners === null` =
 * idle. `onAllSettled` fires once, after the LAST (slowest) column settles — the
 * win-after-stop guarantee (spec §4 bug #1). Remount columns via `spinKey`.
 * Phase B drives count=1; the structure is already N-ready for Phase D.
 */
export function SlotReelStack({
  count,
  spinKey,
  winners,
  reduced,
  baseDurationMs,
  cellSize,
  pulse = false,
  onAllSettled,
}: {
  count: number;
  spinKey: string | number;
  winners: ColumnWinner[] | null;
  reduced: boolean;
  baseDurationMs: number;
  cellSize?: number;
  pulse?: boolean;
  onAllSettled?: () => void;
}) {
  const settledRef = useRef(0);
  useEffect(() => {
    settledRef.current = 0;
  }, [spinKey]);

  const handleColSettled = useCallback(() => {
    settledRef.current += 1;
    if (settledRef.current >= count) onAllSettled?.();
  }, [count, onAllSettled]);

  return (
    <div className="relative flex items-stretch justify-center gap-3 sm:gap-5">
      <PaylineRow reduced={reduced} pulse={pulse} />
      {Array.from({ length: count }, (_, i) => {
        const w = winners ? winners[i] : null;
        return (
          <SlotReelColumn
            key={`${spinKey}-${i}`}
            winnerDex={w ? w.dex : null}
            winnerImage={w?.image}
            winnerName={w?.name}
            tier={w ? w.tier : 'common'}
            reduced={reduced}
            durationMs={baseDurationMs + i * STAGGER_MS}
            cellSize={cellSize}
            onSettled={handleColSettled}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/slots/[slug]/PaylineRow.tsx src/app/slots/[slug]/SlotReelStack.tsx
git commit -m "feat(slots): SlotReelStack (N-capable) + horizontal payline"
```

---

### Task 5: Chrome suppression — useChromeInert hook + data attrs

**Files:**
- Create: `src/lib/use-chrome-inert.ts`
- Modify: `src/components/SiteHeader.tsx` (root `<header>`, line ~112)
- Modify: `src/components/SiteFooter.tsx` (root `<footer>`, line ~141)

**Interfaces:**
- Produces: `useChromeInert(active: boolean): void` — while `active`, locks `document.body` scroll and sets `inert` + `aria-hidden="true"` on every `[data-site-chrome]` element; restores all on cleanup.

> DOM-effect hook (no jsdom in the repo) — verified in Task 8.

- [ ] **Step 1: Create the hook**:

```ts
// src/lib/use-chrome-inert.ts
'use client';

import { useEffect } from 'react';

/**
 * Immersive-surface helper: while `active`, lock body scroll and mark the root
 * site chrome (`[data-site-chrome]` = SiteHeader/SiteFooter) `inert` +
 * `aria-hidden` so focus and the a11y tree can't escape into the chrome behind a
 * full-screen overlay. Restores everything on cleanup. (spec §10, G2 — overlay
 * mechanism, supersedes the route-group plan for Phase B.)
 */
export function useChromeInert(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-site-chrome]'),
    );
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    for (const n of nodes) {
      n.setAttribute('inert', '');
      n.setAttribute('aria-hidden', 'true');
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      for (const n of nodes) {
        n.removeAttribute('inert');
        n.removeAttribute('aria-hidden');
      }
    };
  }, [active]);
}
```

- [ ] **Step 2: Tag the header** — in `src/components/SiteHeader.tsx`, add the attribute to the root `<header>`:

```tsx
    <header
      data-site-chrome
      className="px-fluid sticky top-0 z-50 border-b border-neutral-800 bg-neutral-900 py-3 transition-all duration-300"
    >
```

- [ ] **Step 3: Tag the footer** — in `src/components/SiteFooter.tsx`, add `data-site-chrome` to the root `<footer …>` element (line ~141). Read the current opening tag and insert `data-site-chrome` as the first attribute.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/use-chrome-inert.ts src/components/SiteHeader.tsx src/components/SiteFooter.tsx
git commit -m "feat(slots): useChromeInert + data-site-chrome tags for immersive overlay"
```

---

### Task 6: Rewrite SlotMachineClient → immersive overlay

**Files:**
- Modify: `src/app/slots/[slug]/SlotMachineClient.tsx` (full rewrite of the render + spin wiring; filename + default export kept so `page.tsx` import is unchanged)

**Interfaces:**
- Consumes: `SlotReelStack` + `ColumnWinner` (Task 4), `useChromeInert` (Task 5), `priceTier`/`TIER_COLOR`, `pokemonFromCard`, `openPack`/`revealPull`/`getCreditBalance`/`sellBackPull`, `SlotStatusBar`/`SlotControls`/`OddsSheet`/`SellBackPanel`, `BASE_SPIN_MS`.
- Produces: same default export `SlotMachineClient({ pack, recentPulls })`.

> Integration/visual — verified in Task 8.

- [ ] **Step 1: Replace the file** with this exact content:

```tsx
// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useChromeInert } from '@/lib/use-chrome-inert';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { openPack, revealPull } from '@/lib/actions/packs';
import type { WonCard } from '@/lib/actions/packs';
import { getCreditBalance, sellBackPull } from '@/lib/actions/vault';
import { useSound } from '@/lib/use-sound';
import {
  type ResolvedPack,
  type Pack,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/app/claw/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { BASE_SPIN_MS } from '@/lib/reel';
import { priceTier, TIER_COLOR, type Tier } from '@/lib/price-tier';
import { pokemonFromCard } from '@/lib/pokemon-from-card';
import { SlotReelStack, type ColumnWinner } from './SlotReelStack';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { SellBackPanel, type SellBackOffer } from '@/components/SellBackPanel';

const COOLDOWN_MS = 600;
// Phase B is single-roll; open-batch / count>1 lands in Phase D.
const COLUMN_COUNT = 1;

type Phase = 'idle' | 'resolving' | 'spinning' | 'landed';

export default function SlotMachineClient({
  pack,
  recentPulls,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
}) {
  const reduced = usePrefersReducedMotion();
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  const { customer } = useAuth();
  const { muted, toggleMuted, play, vibrate } = useSound();

  const cost = priceNumber(pack.price);
  const [balance, setBalance] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [cooldown, setCooldown] = useState(false);

  // Won result + a nonce that remounts the reel stack to re-spin.
  const [spin, setSpin] = useState<{
    nonce: number;
    card: WonCard;
    winners: ColumnWinner[];
    tier: Tier;
  } | null>(null);
  // Held until the reel settles (spoiler guard).
  const pending = useRef<{
    balance: number | null;
    offer: SellBackOffer | null;
  } | null>(null);
  const [offer, setOffer] = useState<SellBackOffer | null>(null);
  const [announce, setAnnounce] = useState('');
  const cooldownTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    },
    [],
  );

  // Load balance on mount / auth change.
  useEffect(() => {
    if (!customer) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBalance(null);
      return;
    }
    let cancelled = false;
    getCreditBalance()
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  const canAfford = balance !== null && balance >= cost;
  const spinGuarded = phase === 'resolving' || phase === 'spinning';

  async function handleSpin() {
    if (spinGuarded) return;
    if (!customer) {
      openAuth('login');
      return;
    }
    if (balance !== null && balance < cost) {
      setNeedsTopUp(true);
      setError('Not enough credits to spin.');
      return;
    }
    setError(null);
    setNeedsTopUp(false);
    setOffer(null);
    setAnnounce('');
    setPhase('resolving');
    play('spin');

    const res = await openPack(pack.id);
    if (!res.ok) {
      if (res.needsAuth) openAuth('login');
      else {
        setError(res.error);
        setNeedsTopUp(res.needsTopUp === true);
      }
      setPhase('idle');
      return;
    }

    // Build (but don't yet apply) the post-spin state — spoiler guard.
    const builtOffer: SellBackOffer | null =
      res.pullId !== null && res.marketValue !== null
        ? {
            pullId: res.pullId,
            fmv: res.marketValue,
            cardName: res.card.name,
            image: res.card.image,
            percent: res.buyback?.percent ?? FLAT_BUYBACK_PERCENT,
            amount:
              res.buyback?.amount ??
              Math.round(res.marketValue * FLAT_BUYBACK_PERCENT) / 100,
            vaultPercent: res.buyback?.vaultPercent ?? FLAT_BUYBACK_PERCENT,
            vaultAmount:
              res.buyback?.vaultAmount ??
              Math.round(res.marketValue * FLAT_BUYBACK_PERCENT) / 100,
            instantDeadlineMs:
              res.buyback?.instantDeadlineMs ?? Date.now() + 30_000,
          }
        : null;
    pending.current = { balance: res.balance, offer: builtOffer };

    // Cosmetic mapping (decides nothing): tier color + winner Pokémon (or the
    // §2/G5 card-art fallback when the card has no resolvable Pokémon).
    const tier = priceTier(res.marketValue);
    const mon = pokemonFromCard(res.card.name);
    const winners: ColumnWinner[] = Array.from({ length: COLUMN_COUNT }, () => ({
      dex: mon?.dex ?? null,
      image: mon ? undefined : res.card.image,
      name: mon?.name ?? res.card.name,
      tier,
    }));

    setSpin({ nonce: Date.now(), card: res.card, winners, tier });
    setPhase('spinning');
  }

  // Fired by the stack once the last column settles.
  const handleSettled = useCallback(() => {
    const won = spin?.card;
    if (!won) return;
    const held = pending.current;
    pending.current = null;

    if (held?.balance != null) setBalance(held.balance);
    setOffer(held?.offer ?? null);

    const justPulled: RecentPull = {
      id: `${won.id}-${Date.now()}`,
      name: won.name,
      image: won.image,
      value: won.value,
      rarity: won.rarity,
      packName: pack.name,
      packIcon: pack.image,
      agoLabel: 'just now',
    };
    setRecent((prev) => [justPulled, ...prev].slice(0, 12));

    const big = won.rarity === 'Epic' || won.rarity === 'Legendary';
    play(big ? 'bigwin' : 'win');
    vibrate(big ? [40, 40, 80] : 30);
    setAnnounce(`Won ${won.name}, ${won.value}`);
    setPhase('landed');

    setCooldown(true);
    if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(
      () => setCooldown(false),
      COOLDOWN_MS,
    );
  }, [spin, pack.name, pack.image, play, vibrate]);

  const refreshBalance = useCallback((b: number) => setBalance(b), []);

  const won = phase === 'landed' ? (spin?.card ?? null) : null;
  const tier = spin?.tier ?? null;
  const rgb = won && tier ? TIER_COLOR[tier] : null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-neutral-50">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 px-fluid py-4">
        <Link
          href="/slots"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Exit
        </Link>
        <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />
      </div>

      {/* Center: banner + reel stack + prize */}
      <div
        className="flex flex-1 flex-col items-center justify-center gap-6 px-fluid"
        aria-busy={phase === 'spinning'}
      >
        <div className="min-h-8 text-center">
          {won && rgb && tier && (
            <p
              className="font-heading text-2xl font-bold tracking-tight"
              style={{ color: `rgb(${rgb})` }}
            >
              YOU WON — {tier.toUpperCase()} · {won.value}
            </p>
          )}
          {phase === 'spinning' && (
            <p className="font-heading text-lg font-bold tracking-tight text-white/60">
              SPINNING…
            </p>
          )}
        </div>

        <SlotReelStack
          count={COLUMN_COUNT}
          spinKey={spin?.nonce ?? 'idle'}
          winners={
            phase === 'idle' || phase === 'resolving'
              ? null
              : (spin?.winners ?? null)
          }
          reduced={reduced}
          baseDurationMs={BASE_SPIN_MS}
          pulse={phase === 'landed'}
          onAllSettled={handleSettled}
        />

        {won && (
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-4">
              <Image
                src={won.image}
                alt={won.name}
                width={110}
                height={154}
                className="h-[154px] w-auto rounded-lg object-contain"
              />
              <div className="text-left">
                <p className="text-sm font-semibold text-white">{won.name}</p>
                <p className="text-[13px] text-white/60">
                  Value{' '}
                  <span className="font-bold text-white">{won.value}</span>
                </p>
              </div>
            </div>
            <SellBackPanel
              offer={offer}
              active={phase === 'landed'}
              reduced={reduced}
              onSellBack={sellBackPull}
              onReveal={revealPull}
              onSold={refreshBalance}
            />
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="px-fluid pb-6 pt-2">
        <SlotControls
          cost={cost}
          spinning={phase === 'spinning' || phase === 'resolving'}
          disabled={spinGuarded || cooldown || (customer != null && !canAfford)}
          label={
            !customer
              ? 'Log in to spin'
              : phase === 'landed'
                ? 'Spin again'
                : 'Spin'
          }
          muted={muted}
          onSpin={handleSpin}
          onToggleMute={toggleMuted}
          onOpenOdds={() => setOddsOpen(true)}
        />
        {error && (
          <p role="alert" className="mt-3 text-center text-[12px] text-red-300">
            {error}
            {needsTopUp && (
              <>
                {' '}
                <Link
                  href="/vault"
                  className="font-bold text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                >
                  Add credits in your Vault →
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      {/* Single consolidated announcement (settle-only). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <OddsSheet open={oddsOpen} onClose={() => setOddsOpen(false)} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the Stop hook typechecks the MAIN repo — if it false-flags from a worktree, clean MAIN `.next` + `node_modules/.cache/tsc-hook.tsbuildinfo`).

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/SlotMachineClient.tsx
git commit -m "feat(slots): immersive full-screen reveal driving the vertical reel stack"
```

---

### Task 7: Remove dead ball reel components

**Files:**
- Delete: `src/app/slots/[slug]/SlotReelRow.tsx`, `src/app/slots/[slug]/BallToken.tsx`, `src/app/slots/[slug]/PaylineBeam.tsx`

> Completes spec §12 ball-removal. `RARITY_RGB` lived in `BallToken` and is now unused (the banner switched to `TIER_COLOR`). The pure helpers `buildStrip`/`reelTarget`/`ITEM_W` stay (still tested, harmless).

- [ ] **Step 1: Confirm no live importers**

Run: `git grep -nE "SlotReelRow|BallToken|RARITY_RGB|PaylineBeam" -- src/ ':!src/app/slots/[slug]/SlotReelRow.tsx' ':!src/app/slots/[slug]/BallToken.tsx' ':!src/app/slots/[slug]/PaylineBeam.tsx'`
Expected: NO output (no remaining importers). If anything prints, stop and resolve it before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/app/slots/[slug]/SlotReelRow.tsx src/app/slots/[slug]/BallToken.tsx src/app/slots/[slug]/PaylineBeam.tsx
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS (no unresolved imports).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(slots): remove dead ball reel components (SlotReelRow/BallToken/PaylineBeam)"
```

---

### Task 8: Playwright verification on the prod standalone (:4000)

**Files:**
- Create: `scripts/qa-slots-phaseB.mjs`

> Model the login + standalone-serve boilerplate on the existing **`scripts/qa-slot-machine.mjs`** (it already logs in `test@pokenic.app` and spins the v1 slot). This task adds the Phase-B assertions. Build + serve first per CLAUDE.md: `npm run build` then `pwsh scripts/serve-standalone.ps1 -Port 4000` (run in background). Pick a real slot slug from `/slots`.

- [ ] **Step 1: Write the verify script** — adapt the harness from `qa-slot-machine.mjs`; the Phase-B-specific checks are:

```js
// scripts/qa-slots-phaseB.mjs  (assertions; reuse login/serve helpers from qa-slot-machine.mjs)
// 1. Navigate to /slots/<slug> and screenshot the immersive idle state.
await page.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'docs/research/pw-slots-phaseB-idle.png' });

// 2. Chrome is suppressed: header/footer are inert + aria-hidden, not visible.
const header = page.locator('header[data-site-chrome]');
if (await header.count()) {
  const inert = await header.first().getAttribute('inert');
  const hidden = await header.first().getAttribute('aria-hidden');
  console.log('header inert:', inert !== null, 'aria-hidden:', hidden);
  if (inert === null || hidden !== 'true') throw new Error('chrome not inert');
}

// 3. No win banner before spin.
if (await page.getByText(/YOU WON/i).count()) throw new Error('win shown pre-spin');

// 4. Capture the overlay box, then SPIN, and assert NO layout shift of the overlay.
const before = await page.locator('.fixed.inset-0').first().boundingBox();
await page.getByRole('button', { name: /spin/i }).click();

// 5. During the spin, the win banner must NOT be present (win-after-stop).
await page.waitForTimeout(1500);
if (await page.getByText(/YOU WON/i).count()) throw new Error('win shown mid-spin');

// 6. After settle, the win banner appears and the overlay box is unchanged.
await page.getByText(/YOU WON/i).waitFor({ timeout: 12000 });
const after = await page.locator('.fixed.inset-0').first().boundingBox();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('layout shifted');
await page.screenshot({ path: 'docs/research/pw-slots-phaseB-landed.png' });
console.log('PHASE B OK');
```

- [ ] **Step 2: Build + serve + run**

```bash
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000   # run in background
node scripts/qa-slots-phaseB.mjs
```

Expected: console prints `header inert: true …` and `PHASE B OK`; no thrown error. Read back `docs/research/pw-slots-phaseB-idle.png` and `-landed.png` with the Read tool — idle shows the vertical reel with NO site header/footer; landed shows the grown, tier-glowing winner + win banner.

> **G3 note:** seed cards are $8–40 → the landed glow will read tier 1–2 (gray/light-blue) on real data; the 6-tier mapping itself is unit-covered in `price-tier.test.ts`. High-value fixtures for upper-tier Playwright proof are deferred to Phase E sign-off (or seed one ≥$10k card now if upper-tier visual proof is wanted in B).

- [ ] **Step 3: Commit**

```bash
git add scripts/qa-slots-phaseB.mjs
git commit -m "test(slots): Phase B Playwright verify (immersive, win-after-stop, no shift)"
```

---

### Task 9: Record the spec/memory delta

**Files:**
- Modify: `docs/superpowers/specs/2026-06-18-slot-machine-v2-design.md`
- Modify (memory): `slot-machine-v2-state.md`

> Phase B chose the **fixed-overlay + `inert`** chrome mechanism over the route-group restructure. Record it so the spec stops contradicting the build.

- [ ] **Step 1: Amend spec §10 + §14** — append a rev-4 note to the §10 "Chrome-suppression mechanism" block and the §14 Phase B bullet:

```markdown
> **Rev 4 (Phase B, 2026-06-19):** Phase B suppresses chrome with a **fixed
> `inset-0 z-[100]` overlay + a `useChromeInert` hook** that marks `[data-site-chrome]`
> (SiteHeader/SiteFooter) `inert` + `aria-hidden`, NOT the route-group `(site)`/`(immersive)`
> restructure described above. Chosen for blast radius (no ~25-folder move). The
> route-group option remains available if a later phase needs true multi-root isolation.
```

- [ ] **Step 2: Update the memory file** `slot-machine-v2-state.md` — change the "Deferred → Phase B" line to mark Phase B done and note the overlay decision (G2 resolved via overlay, not route groups), plus the new files. Add a `MEMORY.md` index hook update if the one-liner changed.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-18-slot-machine-v2-design.md
git commit -m "docs(slots): record overlay chrome mechanism (supersedes route groups in Phase B)"
```

---

## Self-Review

**Spec coverage (§ → task):** §2 reel cells/sprites → T2/T3; §2 G5 null fallback → T2 `imageSrc` + T6 winner build; §3 price-tier glow → T6 (`priceTier` + `TIER_COLOR`); §4 bug#1 win-after-stop → T4 `onAllSettled` + T6 phase gating; §4 bug#2 no-shift → T6 `fixed inset-0` + T8 assertion; §6 reel scroll↓/stop/grow-glow → T3; §10 full-screen/a11y/reduced-motion → T3 (reduced) + T5 (inert) + T6 (`role=status`, `aria-busy`); §11 reuse map → T6 imports; §12 ball removal → T7; §13 unit (reelTargetY/buildDexStrip) → T1, Playwright → T8; §14 Phase B → all. Deferred by design (documented): packs/peel (C), `open-batch`/`?count` (D), upper-tier fixtures + final a11y sign-off (E).

**Placeholder scan:** none — every code step carries full content.

**Type consistency:** `ColumnWinner` (T4) `{dex,image?,name?,tier}` matches the `winners` array built in T6 and consumed by `SlotReelColumn` (T3) props. `reelTargetY`/`buildDexStrip`/`ITEM_H`/`STAGGER_MS`/`POKEDEX_MAX` defined in T1, consumed in T3/T4. `useChromeInert(active)` defined T5, called T6. `PokemonToken` `eager`/`imageSrc` defined T2, used T3. `priceTier(res.marketValue): Tier` and `TIER_COLOR[tier]` match `price-tier.ts`.

---

## Execution Handoff

Create the worktree first (superpowers:using-git-worktrees), branched off master `e859757`, then `npm install` in it. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — executing-plans, batched with checkpoints.
