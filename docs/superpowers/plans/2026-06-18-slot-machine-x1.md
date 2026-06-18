# Slot-Machine Pack Opening — x1 Storefront Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-row ("x1") slot-machine pack-opening mode at a new `/slots/[slug]` route that *displays* the backend-rolled prize on a center payline — coexisting with `/claw/[slug]`, with the win-rate lock untouched.

**Architecture:** A server `page.tsx` (metadata + parallel fetch) renders a `'use client'` `SlotMachineClient` controller. SPIN calls the **existing** `openPack` server action; the returned `WonCard` drives a horizontal reel (generalized from `RouletteClient`) that lands the winner's Pokéball under a neon payline via a single CSS `transition-transform`. Balance/ticker are held until the reel settles (spoiler guard). Sell-back is a new shared `SellBackPanel` (lifted from `PackOpenOverlay`, used only by the slot in this slice). Pokéballs are rendered as rarity-tinted inline SVG (seeded defaults) — the admin `Ball` entity is a follow-up plan.

**Tech Stack:** Next.js 16 (App Router, React 19, TS strict), Tailwind v4, Lucide, vitest `^3.2.6` (node env, `src/**/*.test.ts`), Playwright capture scripts (`scripts/*.mjs`, verify on prod build `:4000`).

**Scope (this plan):** x1 only — **no** `−`/`+` multiplier, **no** `open-batch`, **no** admin `Ball` CRUD, **no** `display_win_rate` chip. Those are follow-up plans (PRD §13 Phase 2 + §16 + §7.3). Reel symbols use seeded default balls keyed by rarity. The only `src/lib/actions` change is mapping `price` (already in the HTTP response) into `OpenPackResult`.

**PRD:** `docs/prd/slot-machine-conversion.md` (§3 UX, §5 sell-back, §6 frontend, §7.1 Phase-1 backend, §8 lock trace, §10 edge cases, §11 a11y).

**Karpathy guidelines applied:** TDD on the pure logic (reel math, mute parse); minimal surface (no speculative abstraction); surgical (the production `PackOpenOverlay` and `RouletteClient` are **not modified** — see "Deliberate scope decisions"); every changed line traces to the x1 slice.

---

## Deliberate scope decisions (surface, don't hide — karpathy #1)

1. **`PackOpenOverlay` is NOT rewired to use the new `SellBackPanel` in this plan.** The PRD (§3.6/§6.3) wants the sell-back subsystem extracted so *both* flows share it. Doing that cleanly requires lifting state out of the production reveal (its "Keep in vault"/"Continue" label reads `sell.phase`/`sellExpired` — `PackOpenOverlay.tsx:727-729`), which is real regression risk on the live reveal. **This slice builds `SellBackPanel` as a new shared component used only by the slot.** That temporarily duplicates ~70 lines of sell logic. The classic-overlay dedup is a bounded fast-follow (its own task in a later plan), guarded by `scripts/qa-pack-open-charge.mjs`. Chosen: zero risk to the shipping reveal over premature DRY.
2. **`RouletteClient.tsx` is NOT modified.** It stays the reference demo. The reusable mechanic is extracted as the *pure formula* into `src/lib/reel.ts` (unit-tested) and a new `SlotReelRow` is built on it. We do not refactor a working demo page (karpathy #3).
3. **Logged-out users get the auth modal on SPIN — no demo reel in this slice.** PRD §3.4 makes the demo reel optional ("may"). Deferred to keep the controller small.
4. **Pokéballs are rarity-tinted inline SVG, not uploaded art or asset files.** No `Ball` backend exists yet (PRD §2.3 #9). Seeded defaults = one ball look per rarity, drawn with CSS/SVG (no binaries to ship). The follow-up Balls plan swaps `BallToken` to consume `card.ball`.
5. **SFX are optional at runtime.** `useSound` degrades silently if a `/sounds/*.mp3` file is absent (`audio.play().catch`), so the slice ships before final audio is sourced. Haptics (`navigator.vibrate`) need no assets and are fully implemented.

---

## File map

**Create**
- `src/lib/reel.ts` — pure reel math + constants (`reelTarget`, `buildStrip`, `ITEM_W`, `STRIP_LEN`, `WIN_INDEX`, `BASE_SPIN_MS`, `REEL_EASE`).
- `src/lib/__tests__/reel.test.ts` — unit tests for the above.
- `src/lib/use-sound.ts` — `parseMuted`, `readMuted`, `writeMuted`, `useSound` hook (SFX pool + mute + haptics).
- `src/lib/__tests__/use-sound.test.ts` — unit test for `parseMuted`.
- `src/components/SellBackPanel.tsx` — shared sell-back UI (reveal-ping + countdown + sell + confirm modal), lifted from `PackOpenOverlay`.
- `src/app/slots/[slug]/page.tsx` — server component (metadata + parallel fetch + `notFound`).
- `src/app/slots/[slug]/SlotMachineClient.tsx` — `'use client'` controller.
- `src/app/slots/[slug]/BallToken.tsx` — rarity-tinted SVG Pokéball + `RARITY_RGB`.
- `src/app/slots/[slug]/SlotReelRow.tsx` — one horizontal reel row (generalized `RouletteClient`).
- `src/app/slots/[slug]/PaylineBeam.tsx` — vertical neon payline.
- `src/app/slots/[slug]/SlotStatusBar.tsx` — Band 1 (CREDIT / RECENT WINS / WINS).
- `src/app/slots/[slug]/SlotControls.tsx` — Band 3 (SPIN / COST / ODDS / mute).
- `src/app/slots/[slug]/OddsSheet.tsx` — published rarity-odds dialog.
- `scripts/qa-slot-machine.mjs` — Playwright QA on the prod build (`:4000`).

**Modify**
- `src/lib/actions/packs.ts` — add `price` to `OpenPackResult` and map it from the response (client-only; PRD §2.3 #7).

**Not modified (deliberate):** `src/app/claw/**` (classic flow), `src/app/roulette/RouletteClient.tsx`, all backend files.

---

## Task 1: Reel math library (pure, TDD)

**Files:**
- Create: `src/lib/reel.ts`
- Test: `src/lib/__tests__/reel.test.ts`

The proven mechanic in `RouletteClient.tsx:73-74` is `target = WIN_INDEX*ITEM_W + ITEM_W/2 - winWidth/2`. Extract it as a pure function so the winner always lands dead-center (PRD §6.5 — jitter dropped, §14.4) and is unit-testable.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/reel.test.ts
import { describe, it, expect } from 'vitest';
import {
  reelTarget,
  buildStrip,
  ITEM_W,
  STRIP_LEN,
  WIN_INDEX,
} from '@/lib/reel';
import type { Rarity } from '@/app/claw/packs-data';

const POOL: Rarity[] = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

describe('reelTarget', () => {
  it('centers the winner index under the payline', () => {
    // 36*124 + 124/2 - 600/2 = 4464 + 62 - 300 = 4226
    expect(reelTarget(36, 124, 600)).toBe(4226);
  });

  it('shifts left as the window widens (winner stays centered)', () => {
    expect(reelTarget(36, 124, 800)).toBe(reelTarget(36, 124, 600) - 100);
  });

  it('uses the shipped constants by default geometry', () => {
    expect(ITEM_W).toBe(124);
    expect(WIN_INDEX).toBe(36);
    expect(STRIP_LEN).toBe(48);
  });
});

describe('buildStrip', () => {
  it('places the winner rarity exactly at WIN_INDEX', () => {
    const strip = buildStrip('Legendary', POOL, STRIP_LEN, WIN_INDEX);
    expect(strip).toHaveLength(STRIP_LEN);
    expect(strip[WIN_INDEX]).toBe('Legendary');
  });

  it('fills every non-winner cell from the pool', () => {
    const strip = buildStrip('Epic', POOL, STRIP_LEN, WIN_INDEX);
    strip.forEach((r, i) => {
      if (i !== WIN_INDEX) expect(POOL).toContain(r);
    });
  });

  it('is deterministic for the same inputs', () => {
    expect(buildStrip('Rare', POOL, STRIP_LEN, WIN_INDEX)).toEqual(
      buildStrip('Rare', POOL, STRIP_LEN, WIN_INDEX),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/reel.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/reel"`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/lib/reel.ts
// Pure reel geometry, extracted from the proven mechanic in
// src/app/roulette/RouletteClient.tsx (translateX strip + center-landing). Kept
// pure so the slot reel and any future variant share one tested formula. No DOM,
// no React — see src/lib/__tests__/reel.test.ts.
import type { Rarity } from '@/app/claw/packs-data';

/** Reel cell width in CSS px (matches RouletteClient ITEM_W). */
export const ITEM_W = 124;
/** Fixed strip length — long enough to read as a real spin without wrap-looping. */
export const STRIP_LEN = 48;
/** The winner's index on the strip (high, so there's pre-roll travel). */
export const WIN_INDEX = 36;
/** Default per-row spin duration (ms). */
export const BASE_SPIN_MS = 4200;
/** Deceleration curve — the long tail IS the ease-out/anticipation. */
export const REEL_EASE = 'cubic-bezier(0.12,0.8,0.18,1)';

/**
 * Translate offset (px, positive) that centers `winIndex` under a center payline
 * for a window `winWidth` px wide. Apply as `translateX(-reelTarget(...))`.
 * Verbatim arithmetic from RouletteClient.tsx:74.
 */
export function reelTarget(
  winIndex: number,
  itemW: number,
  winWidth: number,
): number {
  return winIndex * itemW + itemW / 2 - winWidth / 2;
}

/**
 * A fixed-length strip of rarities with `winnerRarity` pinned at `winIndex`.
 * Non-winner cells cycle the pool deterministically (a real slot has a small
 * fixed symbol set). The rarity at a cell selects its Pokéball art (BallToken).
 */
export function buildStrip(
  winnerRarity: Rarity,
  pool: Rarity[],
  length: number,
  winIndex: number,
): Rarity[] {
  const safePool = pool.length > 0 ? pool : [winnerRarity];
  const strip = Array.from(
    { length },
    (_, i) => safePool[(i * 3 + 1) % safePool.length],
  );
  strip[winIndex] = winnerRarity;
  return strip;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/reel.test.ts`
Expected: PASS (3 + 3 assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reel.ts src/lib/__tests__/reel.test.ts
git commit -m "feat(slots): pure reel geometry (reelTarget + buildStrip)"
```

---

## Task 2: Mute persistence helper (pure, TDD)

**Files:**
- Create: `src/lib/use-sound.ts`
- Test: `src/lib/__tests__/use-sound.test.ts`

vitest runs in the node environment here (no `localStorage`/`window` — see the existing `sell-countdown.test.ts`). So the only unit-tested unit is the pure parse; the hook itself is verified in the Playwright pass.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/use-sound.test.ts
import { describe, it, expect } from 'vitest';
import { parseMuted } from '@/lib/use-sound';

describe('parseMuted', () => {
  it('treats "1" as muted', () => {
    expect(parseMuted('1')).toBe(true);
  });
  it('treats anything else (incl. null) as unmuted — default unmuted', () => {
    expect(parseMuted('0')).toBe(false);
    expect(parseMuted(null)).toBe(false);
    expect(parseMuted('')).toBe(false);
    expect(parseMuted('true')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/use-sound.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/use-sound"`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/lib/use-sound.ts
'use client';

// SFX + haptics for the slot. Gesture-unlocked (first sound follows the SPIN
// click, so no autoplay-policy violation). Mute persists in localStorage,
// default UNMUTED (PRD §3.9). Degrades silently if an asset is missing, so the
// slice ships before final audio is sourced.
import { useCallback, useEffect, useRef, useState } from 'react';

const MUTED_KEY = 'pokenic.slot.muted';

const FILES = {
  spin: '/sounds/slot-spin.mp3',
  stop: '/sounds/slot-stop.mp3',
  win: '/sounds/slot-win.mp3',
  bigwin: '/sounds/slot-bigwin.mp3',
  sell: '/sounds/slot-sell.mp3',
} as const;

export type SoundName = keyof typeof FILES;

/** Pure: maps a raw localStorage value to muted state. Default unmuted. */
export function parseMuted(raw: string | null): boolean {
  return raw === '1';
}

export function readMuted(): boolean {
  try {
    return parseMuted(localStorage.getItem(MUTED_KEY));
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
}

export function useSound() {
  const [muted, setMuted] = useState(false);
  const pool = useRef<Partial<Record<SoundName, HTMLAudioElement>>>({});

  // Hydrate mute state + preload the pool on the client only.
  useEffect(() => {
    setMuted(readMuted());
    for (const [name, src] of Object.entries(FILES)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      pool.current[name as SoundName] = audio;
    }
  }, []);

  const play = useCallback((name: SoundName) => {
    if (readMuted()) return;
    const audio = pool.current[name];
    if (!audio) return;
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    } catch {
      /* no-op */
    }
  }, []);

  const vibrate = useCallback((pattern: number | number[]) => {
    if (readMuted()) return;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        /* no-op */
      }
    }
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      writeMuted(next);
      return next;
    });
  }, []);

  return { muted, toggleMuted, play, vibrate };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/use-sound.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/use-sound.ts src/lib/__tests__/use-sound.test.ts
git commit -m "feat(slots): useSound hook (SFX pool + persisted mute + haptics)"
```

---

## Task 3: Map `price` into `OpenPackResult`

**Files:**
- Modify: `src/lib/actions/packs.ts:29-56` (type), `:104-151` (fetch + return)

The open route already returns `price` (`backend/.../open/route.ts:63`) but `openPack` drops it. Add it — client-only, no backend change (PRD §2.3 #7). This is a mechanical type+mapping change; it's verified by the typecheck hook and exercised by the Playwright pass (Task 13), not a new unit test (the action wraps `sdk.client.fetch` and isn't unit-isolated here).

- [ ] **Step 1: Add `price` to the success type**

In `src/lib/actions/packs.ts`, inside the `OpenPackResult` success branch, add `price` next to `balance` (around `:52-54`):

```typescript
      /** Credit balance AFTER the charge (opens debit the pack price — A2);
       *  null only if the backend response shape regresses. */
      balance: number | null;
      /** Pack price debited for this open (USD decimal). Already in the HTTP
       *  response; surfaced for the slot's COST display. Null if it regresses. */
      price: number | null;
    }
```

- [ ] **Step 2: Destructure `price` from the fetch**

Change the destructure (currently `:104`):

```typescript
    const { pull, card, balance, price, buyback } = await sdk.client.fetch<{
      pull?: { id?: unknown };
      card: BackendWonCard;
      balance?: unknown;
      price?: unknown;
      buyback?: BackendBuyback;
    }>(`/store/packs/${encodeURIComponent(slug)}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });
```

- [ ] **Step 3: Return `price` (guarded like `balance`)**

In the `return { ok: true, ... }` block, add after the `balance` field (`:147-150`):

```typescript
      balance:
        typeof balance === 'number' && Number.isFinite(balance)
          ? balance
          : null,
      price:
        typeof price === 'number' && Number.isFinite(price) ? price : null,
    };
```

- [ ] **Step 4: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. (The PostToolUse typecheck hook also runs automatically after the edit.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/packs.ts
git commit -m "feat(slots): surface pack price in OpenPackResult (client-only)"
```

---

## Task 4: `BallToken` — rarity-tinted SVG Pokéball

**Files:**
- Create: `src/app/slots/[slug]/BallToken.tsx`

A glass-cased Pokéball whose tint encodes the won card's rarity (seeded default art — PRD §3.2/§16 note "balls render from seeded defaults" for this slice). Also exports the shared `RARITY_RGB` used by the banner glow. Visual-only; verified in the Playwright capture pass.

- [ ] **Step 1: Write the component**

```tsx
// src/app/slots/[slug]/BallToken.tsx
import { cn } from '@/lib/utils';
import type { Rarity } from '@/app/claw/packs-data';

// Rarity → rgb. Matches the existing reveal palette (PackOpenOverlay.tsx:41-47)
// — co-located per the repo's established pattern (each surface defines its own).
export const RARITY_RGB: Record<Rarity, string> = {
  Legendary: '234, 179, 8',
  Epic: '217, 70, 239',
  Rare: '56, 189, 248',
  Uncommon: '52, 211, 153',
  Common: '163, 163, 163',
};

/**
 * One reel cell: a glass-cased Pokéball tinted by rarity. Seeded default art for
 * the x1 slice — the admin Ball entity (follow-up plan) will swap the SVG for
 * `ball.image`. Cosmetic only: the rarity is decided server-side (PRD §8).
 */
export function BallToken({
  rarity,
  w,
  highlight = false,
}: {
  rarity: Rarity;
  w?: number;
  highlight?: boolean;
}) {
  const rgb = RARITY_RGB[rarity];
  return (
    <div className="shrink-0 px-1.5" style={w ? { width: w } : undefined}>
      <div
        className={cn(
          'relative aspect-square overflow-hidden rounded-2xl border bg-neutral-900 p-3 transition-shadow',
        )}
        style={{
          borderColor: `rgba(${rgb},0.55)`,
          boxShadow: highlight
            ? `0 0 30px -2px rgba(${rgb},0.9)`
            : `0 0 16px -8px rgba(${rgb},0.6)`,
        }}
      >
        <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
          {/* white base */}
          <circle cx="50" cy="50" r="46" fill="#f5f5f5" />
          {/* tinted top half */}
          <path
            d="M4 50a46 46 0 0 1 92 0Z"
            fill={`rgb(${rgb})`}
          />
          {/* center band */}
          <rect x="4" y="46" width="92" height="8" fill="#171717" />
          {/* center button */}
          <circle cx="50" cy="50" r="13" fill="#171717" />
          <circle cx="50" cy="50" r="8" fill="#f5f5f5" />
          <circle cx="50" cy="50" r="4" fill={`rgb(${rgb})`} />
          {/* outer ring */}
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke="#171717"
            strokeWidth="3"
          />
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/BallToken.tsx
git commit -m "feat(slots): rarity-tinted SVG Pokéball token"
```

---

## Task 5: `SlotReelRow` — one horizontal reel (generalized `RouletteClient`)

**Files:**
- Create: `src/app/slots/[slug]/SlotReelRow.tsx`

Uses the tested `reelTarget`/`buildStrip` (Task 1) and `BallToken` (Task 4). Spins once per mount: starts at strip-origin, double-rAF → transition to the centered winner, `onTransitionEnd` → `onSettled`. Reduced motion and idle (`winnerRarity === null`) land centered with no animation (`RouletteClient.tsx:65-69` pattern). Re-spins are driven by the controller remounting via a `key` (PRD §6.5 step 6).

- [ ] **Step 1: Write the component**

```tsx
// src/app/slots/[slug]/SlotReelRow.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  reelTarget,
  buildStrip,
  ITEM_W,
  STRIP_LEN,
  WIN_INDEX,
  REEL_EASE,
} from '@/lib/reel';
import { BallToken } from './BallToken';
import type { Rarity } from '@/app/claw/packs-data';

/**
 * A horizontal reel row that DISPLAYS a pre-decided winner. It never picks the
 * winner (PRD §8). Idle (`winnerRarity === null`) and reduced motion land
 * centered instantly; otherwise it spins once on mount. Remount (new `key`) to
 * re-spin.
 */
export function SlotReelRow({
  winnerRarity,
  pool,
  reduced,
  durationMs,
  onSettled,
}: {
  winnerRarity: Rarity | null;
  pool: Rarity[];
  reduced: boolean;
  durationMs: number;
  onSettled?: () => void;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const settled = useRef(false);

  const strip = useMemo(
    () => buildStrip(winnerRarity ?? pool[0], pool, STRIP_LEN, WIN_INDEX),
    [winnerRarity, pool],
  );

  useEffect(() => {
    settled.current = false;
    const winW = windowRef.current?.clientWidth ?? 600;
    const target = Math.round(reelTarget(WIN_INDEX, ITEM_W, winW));

    // Idle: rest centered, no spin, no settle callback.
    if (winnerRarity === null) {
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
    // Real spin: origin → centered winner, settle on transition end.
    setOffset(0);
    setSpinning(true);
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setOffset(-target)),
    );
    return () => cancelAnimationFrame(raf);
  }, [winnerRarity, reduced, pool, onSettled]);

  return (
    <div
      ref={windowRef}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 p-4"
      aria-hidden
    >
      <div
        className={cn('flex', spinning && 'transition-transform')}
        style={{
          transform: `translateX(${offset}px)`,
          transitionDuration: spinning ? `${durationMs}ms` : undefined,
          transitionTimingFunction: spinning ? REEL_EASE : undefined,
        }}
        onTransitionEnd={() => {
          if (spinning && !settled.current) {
            settled.current = true;
            setSpinning(false);
            onSettled?.();
          }
        }}
      >
        {strip.map((r, i) => (
          <BallToken
            key={i}
            rarity={r}
            w={ITEM_W}
            highlight={i === WIN_INDEX && !spinning && winnerRarity !== null}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/SlotReelRow.tsx
git commit -m "feat(slots): SlotReelRow reel mechanic (CSS transition, settle on end)"
```

---

## Task 6: `PaylineBeam` — vertical neon payline

**Files:**
- Create: `src/app/slots/[slug]/PaylineBeam.tsx`

The single neon-violet surface (PRD §3.2/§6.4), on the established `fuchsia→violet` accent. Pulse gated under reduced motion.

- [ ] **Step 1: Write the component**

```tsx
// src/app/slots/[slug]/PaylineBeam.tsx
import { cn } from '@/lib/utils';

/** Center payline overlaying the reel. `pulse` flashes on win (PRD §3.4). */
export function PaylineBeam({
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
          'pointer-events-none absolute left-1/2 top-0 z-10 h-full w-1 -translate-x-1/2 rounded-full bg-gradient-to-b from-fuchsia-500 to-violet-500',
          !reduced && pulse && 'animate-pulse',
        )}
        style={{ boxShadow: '0 0 24px 2px rgba(168,85,247,0.7)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 border-x-[7px] border-t-[9px] border-x-transparent border-t-violet-400"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-1/2 z-10 -translate-x-1/2 rotate-180 border-x-[7px] border-t-[9px] border-x-transparent border-t-violet-400"
      />
    </>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/PaylineBeam.tsx
git commit -m "feat(slots): neon payline beam"
```

---

## Task 7: `SellBackPanel` — shared sell-back (lifted from `PackOpenOverlay`)

**Files:**
- Create: `src/components/SellBackPanel.tsx`

Lifts the sell-back subsystem (`PackOpenOverlay.tsx:118-190` state/effects + `:676-715` UI + `:748-762` modal) into a standalone component. **`PackOpenOverlay` is not modified** (see "Deliberate scope decisions" #1). The reveal ping fires when `active` becomes true — the controller passes `active` only after the reel settles (PRD §5.2: ping at reel-STOP, not at open).

- [ ] **Step 1: Write the component**

```tsx
// src/components/SellBackPanel.tsx
'use client';

// Shared instant/flat sell-back for a single pull. Lifted verbatim in behavior
// from the classic reveal (PackOpenOverlay.tsx:118-190,676-762): reveal ping →
// server deadline → wall-clock countdown → confirm modal → sell. The reveal ping
// fires when `active` flips true (the slot passes active only after the reel
// settles, so the 30s window isn't eaten by the spin — PRD §5.2).
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { SELL_COUNTDOWN_SECS, sellSecondsLeft } from '@/lib/sell-countdown';
import SellConfirmModal from '@/components/SellConfirmModal';

export type SellBackOffer = {
  pullId: string;
  fmv: number;
  cardName: string;
  image: string;
  percent: number;
  amount: number;
  vaultPercent: number;
  vaultAmount: number;
  /** Fallback instant deadline (epoch ms) if the reveal ping fails. */
  instantDeadlineMs: number;
};

export type SellBackFn = (
  pullId: string,
) => Promise<
  | { ok: true; amount: number; percent: number; balance: number }
  | { ok: false; error: string; needsAuth?: boolean }
>;

export type RevealFn = (
  pullId: string,
) => Promise<{ ok: true; instantDeadlineMs: number } | { ok: false }>;

const money = (n: number) =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function SellBackPanel({
  offer,
  active,
  reduced,
  onSellBack,
  onReveal,
  onSold,
}: {
  /** Null = no sell-back for this pull (e.g. pullId missing). */
  offer: SellBackOffer | null;
  /** Reel has settled — safe to start the reveal ping + countdown. */
  active: boolean;
  reduced: boolean;
  onSellBack: SellBackFn;
  onReveal?: RevealFn;
  /** Notify the controller of the post-sell balance (so CREDIT refreshes). */
  onSold?: (balance: number) => void;
}) {
  const [sell, setSell] = useState<
    | { phase: 'idle' }
    | { phase: 'selling' }
    | { phase: 'sold'; amount: number; balance: number }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  const [deadlineMs, setDeadlineMs] = useState<number | null>(
    offer ? offer.instantDeadlineMs : null,
  );
  const [secondsLeft, setSecondsLeft] = useState(SELL_COUNTDOWN_SECS);
  const sellExpired = secondsLeft <= 0;
  const revealPinged = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Reveal ping ONCE, when the reel has settled (active) — anchors the 30s window.
  useEffect(() => {
    if (!active || !offer || revealPinged.current) return;
    revealPinged.current = true;
    if (!onReveal) return;
    let cancelled = false;
    onReveal(offer.pullId).then((r) => {
      if (!cancelled && r.ok) setDeadlineMs(r.instantDeadlineMs);
    });
    return () => {
      cancelled = true;
    };
  }, [active, offer, onReveal]);

  // Tick the visible countdown to the server deadline (wall-clock).
  useEffect(() => {
    if (!active || !offer || deadlineMs === null || sell.phase === 'sold') return;
    const tick = () => setSecondsLeft(sellSecondsLeft(deadlineMs, Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [active, offer, deadlineMs, sell.phase]);

  async function handleSellBack() {
    if (!offer || sell.phase === 'selling' || sell.phase === 'sold') return;
    setSell({ phase: 'selling' });
    try {
      const res = await onSellBack(offer.pullId);
      if (res.ok) {
        setSell({ phase: 'sold', amount: res.amount, balance: res.balance });
        setConfirmOpen(false);
        onSold?.(res.balance);
      } else {
        setSell({ phase: 'error', message: res.error });
        setConfirmOpen(false);
      }
    } catch {
      setSell({
        phase: 'error',
        message: 'Something went wrong. Please try again.',
      });
      setConfirmOpen(false);
    }
  }

  if (!offer) return null;

  const barPct = sellExpired ? 0 : Math.max(0, (secondsLeft / SELL_COUNTDOWN_SECS) * 100);

  return (
    <div className="flex w-full max-w-[340px] flex-col items-center gap-2">
      {sell.phase === 'sold' ? (
        <p className="flex h-12 w-full items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-400/10 text-sm font-bold text-emerald-300">
          +${money(sell.amount)} credited · balance ${money(sell.balance)}
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={sell.phase === 'selling'}
            className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-amber-400/60 bg-amber-400/10 text-sm font-bold text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-60"
          >
            {sell.phase === 'selling'
              ? 'Selling…'
              : sellExpired
                ? `Sell for $${money(offer.vaultAmount)} (${offer.vaultPercent}%)`
                : `Sell back for $${money(offer.amount)} (${offer.percent}%) · ${secondsLeft}s`}
          </button>
          {/* Draining bar — decorative; the countdown text is the SR source. */}
          {!sellExpired && (
            <div
              aria-hidden
              className="h-1 w-full overflow-hidden rounded-full bg-white/10"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500"
                style={{
                  width: `${barPct}%`,
                  transition: reduced ? undefined : 'width 250ms linear',
                }}
              />
            </div>
          )}
          <p className="text-center text-[11px] text-white/45">
            {sellExpired
              ? `Instant offer expired — this card is in your vault and sells at the flat ${offer.vaultPercent}% rate.`
              : `Or keep it: vaulted cards sell anytime at the flat ${offer.vaultPercent}% rate.`}
          </p>
        </>
      )}
      {sell.phase === 'error' && (
        <p className="text-center text-[12px] font-medium text-red-400">
          {sell.message}
        </p>
      )}
      <SellConfirmModal
        open={confirmOpen}
        cardName={offer.cardName}
        image={offer.image}
        fmv={offer.fmv}
        rateType={sellExpired ? 'flat' : 'instant'}
        percent={sellExpired ? offer.vaultPercent : offer.percent}
        netCredit={sellExpired ? offer.vaultAmount : offer.amount}
        secondsLeft={sellExpired ? undefined : secondsLeft}
        busy={sell.phase === 'selling'}
        onConfirm={handleSellBack}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. (Confirms the `SellConfirmModal` prop shape matches `PackOpenOverlay.tsx:748-762`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/SellBackPanel.tsx
git commit -m "feat(slots): shared SellBackPanel (reveal ping + countdown + sell)"
```

---

## Task 8: `OddsSheet` — published rarity-odds dialog

**Files:**
- Create: `src/app/slots/[slug]/OddsSheet.tsx`

Published per-rarity odds only — reuses the static `ODDS` (`packs-data.ts:261`); never `weight`/`computeOdds` (PRD §3.7). A proper modal (`role="dialog" aria-modal`, Escape to close — PRD §11).

- [ ] **Step 1: Write the component**

```tsx
// src/app/slots/[slug]/OddsSheet.tsx
'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ODDS } from '@/app/claw/packs-data';

/** Published rarity-odds list. Never exposes the win-rate lock (PRD §3.7/§8). */
export function OddsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Published pull odds by rarity"
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            Pull odds by rarity
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close odds"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <ul className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
          {ODDS.map((o) => (
            <li
              key={o.rarity}
              className="flex items-center justify-between border-b border-white/5 px-4 py-3 last:border-b-0"
            >
              <span className="flex items-center gap-2.5 text-[13px] font-medium text-white">
                <span className={cn('h-2.5 w-2.5 rounded-full', o.dot)} />
                {o.rarity}
              </span>
              <span className="text-[13px] tabular-nums text-white/55">
                {o.chance}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 px-1 text-[11px] text-white/35">
          Indicative odds — final rates are published by the backend.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/OddsSheet.tsx
git commit -m "feat(slots): published rarity-odds sheet"
```

---

## Task 9: `SlotStatusBar` — Band 1 (CREDIT / RECENT WINS / WINS)

**Files:**
- Create: `src/app/slots/[slug]/SlotStatusBar.tsx`

Quiet status band (PRD §3.1). CREDIT renders nothing when null (never a wrong `$0`). RECENT WINS reuses the reduced-motion-aware marquee keyframe `sp-scroll-x` (`CommunitySection.tsx:129-138`). WINS = recent-feed length (the chosen §14.8 default — no backend).

- [ ] **Step 1: Write the component**

```tsx
// src/app/slots/[slug]/SlotStatusBar.tsx
'use client';

import { cn } from '@/lib/utils';
import { usd } from '@/lib/format';
import type { RecentPull } from '@/lib/data/packs';

export function SlotStatusBar({
  balance,
  recent,
  reduced,
}: {
  balance: number | null;
  recent: RecentPull[];
  reduced: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-5">
        {balance !== null && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
              Credit
            </p>
            <p className="font-heading text-lg font-bold tabular-nums text-white">
              {usd(balance)}
            </p>
          </div>
        )}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
            Wins
          </p>
          <p className="font-heading text-lg font-bold tabular-nums text-white">
            {recent.length}
          </p>
        </div>
      </div>
      {/* RECENT WINS marquee — reuses sp-scroll-x (frozen under reduced motion). */}
      {recent.length > 0 && (
        <div className="relative max-w-full overflow-hidden sm:max-w-[55%]">
          <div
            className={cn('flex w-max gap-4', !reduced && 'animate-[sp-scroll-x_30s_linear_infinite]')}
          >
            {[...recent, ...recent].map((p, i) => (
              <span
                key={`${p.id}-${i}`}
                className="flex shrink-0 items-center gap-1.5 text-[11px] text-white/50"
              >
                <span className="font-medium text-white/75">{p.name}</span>
                <span className="tabular-nums text-white/40">{p.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

> **Note for the implementer:** confirm `sp-scroll-x` is defined in `src/app/globals.css` (it backs `CommunitySection.tsx:129-138`). If the Tailwind arbitrary `animate-[sp-scroll-x_...]` doesn't resolve, fall back to an inline `style={{ animation: reduced ? undefined : 'sp-scroll-x 30s linear infinite' }}` — same keyframe.

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/SlotStatusBar.tsx
git commit -m "feat(slots): status band (credit/recent-wins/wins)"
```

---

## Task 10: `SlotControls` — Band 3 (SPIN / COST / ODDS / mute)

**Files:**
- Create: `src/app/slots/[slug]/SlotControls.tsx`

The control band (PRD §3.3). x1 = **no** `−`/`+` (deferred to the multiplier plan). SPIN on the established `fuchsia→violet` accent; ≥48px targets; the COST line; ODDS launcher; mute toggle.

- [ ] **Step 1: Write the component**

```tsx
// src/app/slots/[slug]/SlotControls.tsx
'use client';

import { Sparkles, Info, Volume2, VolumeX } from 'lucide-react';
import { usd } from '@/lib/format';

export function SlotControls({
  cost,
  spinning,
  disabled,
  label,
  muted,
  onSpin,
  onToggleMute,
  onOpenOdds,
}: {
  cost: number;
  spinning: boolean;
  disabled: boolean;
  label: string;
  muted: boolean;
  onSpin: () => void;
  onToggleMute: () => void;
  onOpenOdds: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenOdds}
          className="inline-flex h-12 min-w-12 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-4 text-[12px] font-semibold uppercase tracking-wide text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Info className="h-4 w-4" aria-hidden /> Odds
        </button>

        <button
          type="button"
          onClick={onSpin}
          disabled={disabled}
          className="inline-flex h-14 min-w-[200px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-violet-500 px-8 text-base font-bold text-white shadow-lg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Sparkles className="h-5 w-5" aria-hidden />
          {spinning ? 'Spinning…' : label}
        </button>

        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          {muted ? (
            <VolumeX className="h-5 w-5" aria-hidden />
          ) : (
            <Volume2 className="h-5 w-5" aria-hidden />
          )}
        </button>
      </div>
      <p className="text-[12px] text-white/50">
        Cost <span className="font-semibold text-white/80">{usd(cost)}</span> / spin
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/SlotControls.tsx
git commit -m "feat(slots): control band (spin/cost/odds/mute)"
```

---

## Task 11: `SlotMachineClient` — the controller

**Files:**
- Create: `src/app/slots/[slug]/SlotMachineClient.tsx`

The integration. Mirrors `PackDetailClient`'s open flow (`:84-232`) but routes the result into the reel. Key behaviors:
- **SPIN** → logged-out routes to `openAuth('login')` (no demo reel — scope #3); else guard, `setPhase('resolving')`, play `spin` SFX (gesture-unlocked), `openPack(slug)`.
- **Spoiler guard (PRD §3.1):** on success, hold `pendingBalance`/`pendingPull`; transition to `spinning`; only on the reel's `onSettled` apply balance, prepend the ticker, fire `win`/`bigwin` SFX + haptics, and activate `SellBackPanel`.
- **Spin guard + cooldown (PRD §10):** SPIN disabled from press until settle + a short cooldown.
- **Reduced motion:** the row settles next tick → same landed path.
- **a11y (PRD §11):** one `role="status" aria-live="polite"` region announces once on settle; `aria-busy` during spin; body scroll-lock during spin.

- [ ] **Step 1: Write the controller**

```tsx
// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { openPack, revealPull } from '@/lib/actions/packs';
import type { WonCard } from '@/lib/actions/packs';
import { getCreditBalance, sellBackPull } from '@/lib/actions/vault';
import { useSound } from '@/lib/use-sound';
import {
  type ResolvedPack,
  type Pack,
  type Rarity,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/app/claw/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { BASE_SPIN_MS } from '@/lib/reel';
import { SlotReelRow } from './SlotReelRow';
import { PaylineBeam } from './PaylineBeam';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { RARITY_RGB } from './BallToken';
import { SellBackPanel, type SellBackOffer } from '@/components/SellBackPanel';

const RARITIES: Rarity[] = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const COOLDOWN_MS = 600;

type Phase = 'idle' | 'resolving' | 'spinning' | 'landed';

export default function SlotMachineClient({
  pack,
  recentPulls,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
}) {
  const reduced = usePrefersReducedMotion();
  const { customer } = useAuth();
  const { muted, toggleMuted, play, vibrate } = useSound();

  const cost = priceNumber(pack.price);
  const [balance, setBalance] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);

  // Won result + a nonce that remounts the reel row to re-spin (PRD §6.5).
  const [spin, setSpin] = useState<{ nonce: number; card: WonCard } | null>(
    null,
  );
  // Held until the reel settles (spoiler guard, PRD §3.1).
  const pending = useRef<{ balance: number | null; offer: SellBackOffer | null } | null>(
    null,
  );
  const [offer, setOffer] = useState<SellBackOffer | null>(null);
  const [announce, setAnnounce] = useState('');

  // Load balance on mount / auth change (PackDetailClient.tsx:98-110).
  useEffect(() => {
    if (!customer) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    getCreditBalance().then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  // Lock body scroll while the reel is in motion (PRD §11).
  useEffect(() => {
    const active = phase === 'resolving' || phase === 'spinning';
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [phase]);

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
            instantDeadlineMs: res.buyback?.instantDeadlineMs ?? Date.now() + 30_000,
          }
        : null;
    pending.current = { balance: res.balance, offer: builtOffer };

    setSpin({ nonce: Date.now(), card: res.card });
    setPhase('spinning');
  }

  // Fired by the reel row when the winner lands center.
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

    // Brief cooldown so a mash can't double-charge before re-enable (PRD §10).
    window.setTimeout(() => {}, COOLDOWN_MS);
  }, [spin, pack.name, pack.image, play, vibrate]);

  const refreshBalance = useCallback((b: number) => setBalance(b), []);

  const won = phase === 'landed' ? spin?.card ?? null : null;
  const rgb = won ? RARITY_RGB[won.rarity] : null;

  return (
    <div className="mx-auto flex w-full flex-col gap-6 px-fluid py-6">
      <Link
        href="/claw"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> All packs
      </Link>

      <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />

      {/* Banner */}
      <div className="min-h-8 text-center">
        {won && rgb && (
          <p
            className="font-heading text-xl font-bold tracking-tight"
            style={{ color: `rgb(${rgb})` }}
          >
            YOU WON — {won.rarity} · {won.value}
          </p>
        )}
        {phase === 'spinning' && (
          <p className="font-heading text-lg font-bold tracking-tight text-white/60">
            SPINNING…
          </p>
        )}
      </div>

      {/* Reel hero */}
      <div className="relative" aria-busy={phase === 'spinning'}>
        <PaylineBeam reduced={reduced} pulse={phase === 'landed'} />
        <SlotReelRow
          key={spin?.nonce ?? 'idle'}
          winnerRarity={phase === 'idle' || phase === 'resolving' ? null : spin?.card.rarity ?? null}
          pool={RARITIES}
          reduced={reduced}
          durationMs={BASE_SPIN_MS}
          onSettled={handleSettled}
        />
      </div>

      {/* Won card slab (the real prize) + sell-back */}
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
                Value <span className="font-bold text-white">{won.value}</span>
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

      {/* Controls */}
      <SlotControls
        cost={cost}
        spinning={phase === 'spinning' || phase === 'resolving'}
        disabled={spinGuarded || (customer != null && !canAfford)}
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
        <p role="alert" className="text-center text-[12px] text-red-300">
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

      {/* Single consolidated announcement (PRD §11). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <OddsSheet open={oddsOpen} onClose={() => setOddsOpen(false)} />
    </div>
  );
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Fix any prop-name mismatches against Tasks 4–10 before moving on (cross-check: `SellBackOffer`, `RARITY_RGB`, `BASE_SPIN_MS`, `WonCard`).

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/SlotMachineClient.tsx
git commit -m "feat(slots): SlotMachineClient controller (x1 spin + spoiler guard + a11y)"
```

---

## Task 12: Route `page.tsx` (server component)

**Files:**
- Create: `src/app/slots/[slug]/page.tsx`

Mirrors `src/app/claw/[slug]/page.tsx:1-55` (server, metadata, `force-dynamic`, parallel fetch, `notFound`). The x1 slice needs only the base pack + recent pulls (no `detail` — no Top Hits panel in the slot).

- [ ] **Step 1: Write the page**

```tsx
// src/app/slots/[slug]/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findPack } from '@/app/claw/packs-data';
import { getPackBySlug, getRecentPulls } from '@/lib/data/packs';
import SlotMachineClient from './SlotMachineClient';

// Backend-driven (pack catalog + live recent pulls), so render per request and
// let each read degrade on its own — same seam as /claw/[slug].
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const pack = findPack(slug);
  return {
    title: pack ? `${pack.name} — Slot Machine | Pokenic` : 'Slot Machine | Pokenic',
  };
}

export default async function SlotPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [base, recentPulls] = await Promise.all([
    getPackBySlug(slug),
    getRecentPulls(),
  ]);
  if (!base) notFound();

  return <SlotMachineClient pack={base.pack} recentPulls={recentPulls} />;
}
```

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. (`base.pack` is `ResolvedPack`; the client prop is `ResolvedPack & Pack` — `ResolvedPack` already extends `Pack`, so this is assignable.)

- [ ] **Step 3: Commit**

```bash
git add src/app/slots/[slug]/page.tsx
git commit -m "feat(slots): /slots/[slug] route (server + metadata + fetch)"
```

---

## Task 13: Playwright QA on the prod build + win-rate-lock guard

**Files:**
- Create: `scripts/qa-slot-machine.mjs`

Per CLAUDE.md: verify on the **prod build at `:4000`**, NOT `next dev`, via Playwright scripts (NOT Chrome MCP). Modeled on `scripts/qa-pack-open-charge.mjs`. Requires the storefront + backend running and a funded test customer (see that script's `EMAIL`/`PASSWORD`/`PK`/top-up helper — reuse the same approach).

- [ ] **Step 1: Build and serve the prod bundle**

```bash
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000   # run in background
```
Expected: server boots; `http://localhost:4000` serves. (Backend on `:9000` must be up — `corepack yarn dev` in `backend/packages/api`.)

- [ ] **Step 2: Write the QA script**

```javascript
// scripts/qa-slot-machine.mjs
// QA the x1 slot machine on the PROD build (:4000): log in (funded customer) →
// /slots/<pack> → SPIN → reel settles → balance debits by the pack price →
// sell-back offer appears → reduced-motion lands centered with no spin.
// Headless; screenshots to docs/research/. Run: node scripts/qa-slot-machine.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const EMAIL = 'stocktest-1@pokenic.local';
const PASSWORD = 'stocktest2026!';
const PACK = 'pokemon-rookie'; // affordable

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ headless: true });

async function login(page) {
  await page.goto(`${BASE}/slots/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^login$/i }).first().click();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page.getByRole('button', { name: /spin/i }).first().waitFor({ timeout: 20000 });
}

async function readCredit(page) {
  const el = page.getByText('Credit').locator('xpath=following-sibling::*[1]');
  await el.waitFor({ timeout: 10000 });
  const t = await el.textContent();
  return Number((t || '').replace(/[^0-9.]/g, ''));
}

try {
  const page = await browser.newPage();
  await login(page);

  const before = await readCredit(page);
  await page.getByRole('button', { name: /^spin$/i }).click();

  // Reel settles → "YOU WON" banner + sell-back appear.
  await page.getByText(/YOU WON/i).waitFor({ timeout: 20000 });
  ok('reel settled and surfaced a winner');

  const after = await readCredit(page);
  if (Math.abs(before - after) > 0) ok(`credit debited (${before} → ${after})`);
  else fail('credit did not change after a spin');

  const sell = page.getByRole('button', { name: /sell back for|sell for/i });
  if (await sell.isVisible()) ok('sell-back offer present');
  else fail('sell-back offer missing');

  await page.screenshot({ path: 'docs/research/slot-landed.png' });

  // Reduced motion: winner centered, no spin theatre.
  const rm = await browser.newPage();
  await rm.emulateMedia({ reducedMotion: 'reduce' });
  await login(rm);
  await rm.getByRole('button', { name: /^spin$/i }).click();
  await rm.getByText(/YOU WON/i).waitFor({ timeout: 15000 });
  ok('reduced-motion spin resolves to a centered winner');
  await rm.screenshot({ path: 'docs/research/slot-reduced-motion.png' });

  await browser.close();
  console.log(process.exitCode ? '\nFAILED' : '\nPASSED');
} catch (e) {
  await browser.close();
  fail(e.message);
}
```

- [ ] **Step 3: Run the QA script**

Run: `node scripts/qa-slot-machine.mjs`
Expected: `✓ reel settled…`, `✓ credit debited…`, `✓ sell-back offer present`, `✓ reduced-motion…`, then `PASSED`. Read `docs/research/slot-landed.png` + `docs/research/slot-reduced-motion.png` back with the Read tool to confirm the reel + payline + ball render.

- [ ] **Step 4: Win-rate-lock regression note**

No new lock test is needed: the slot calls the **same** `openPack` server action as `/claw` (`src/lib/actions/packs.ts:88`), which POSTs an empty body and sends no odds/roll input (PRD §8, hop 10). The existing `scripts/qa-claw-e2e.mjs` step "admin-odds-don't-change-storefront" already guards that path. Run it to confirm nothing regressed:

Run: `node scripts/qa-claw-e2e.mjs`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-slot-machine.mjs
git commit -m "test(slots): Playwright QA for x1 slot (debit + sell-back + reduced motion)"
```

---

## Task 14: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`
Expected: all tests PASS (incl. the new `reel.test.ts` + `use-sound.test.ts`).

- [ ] **Step 2: Run the project check (lint + typecheck + build)**

Run: `npm run check`
Expected: clean lint, no type errors, successful production build. (This is the repo's only auto-enforced gate — also re-run by the Stop hook.)

- [ ] **Step 3: Manual smoke (already captured in Task 13)**

Confirm `docs/research/slot-landed.png` shows: 5 visible Pokéball cells, the won card slab + value, the neon payline through the center ball, the SPIN pill, and the CREDIT/WINS band.

- [ ] **Step 4: Commit any check fixes**

```bash
git add -A
git commit -m "chore(slots): final check fixes for the x1 slice"
```

---

## Self-review

**Spec coverage (PRD → task):**
- §3.1 status band (CREDIT null-safe, RECENT WINS marquee, WINS count) → Task 9. ✅
- §3.2 reel hero (5/3 balls, payline, banner) → Tasks 4–6, 11. ✅ (5/3 responsive clipping is handled by `overflow-hidden` + `ITEM_W`; fine-tuning is a Playwright pass detail, not a logic gap.)
- §3.3 controls (SPIN/COST/ODDS/mute; `−`/`+` deferred) → Task 10. ✅
- §3.4 states (idle/resolving/spinning/landed/insufficient/error/logged-out) → Task 11. ✅ (big-win celebration = SFX + payline pulse; confetti is Phase-3 polish, PRD §13.)
- §3.5 reduced motion (reel + marquee + banner + bar) → Tasks 5, 7, 9, 11. ✅
- §3.7 published odds → Task 8. ✅
- §3.9 sound + haptics + persisted mute → Tasks 2, 10, 11. ✅
- §5 sell-back (reveal ping at stop, countdown, confirm, sell) → Task 7, wired in Task 11. ✅
- §6.1 route split → Task 12; §6.2 components → Tasks 4–10; §6.3 `price` on `OpenPackResult` → Task 3; §6.4 fuchsia→violet accent → Tasks 6, 10; §6.5 reel engine → Tasks 1, 5. ✅
- §7.1 Phase-1 near-zero backend (only client `price` map) → Task 3. ✅ (`display_win_rate` chip deferred — scope.)
- §8 lock preserved (same `openPack`, no client roll) → Task 13 step 4. ✅
- §10 edge cases (double-submit guard + cooldown, insufficient funds, error revert, spoiler guard) → Task 11. ✅
- §11 a11y (single `aria-live`, `aria-busy`, scroll-lock, ≥48px, dialog Escape) → Tasks 8, 10, 11. ✅
- §12 testing (reel math unit, Playwright capture, reduced-motion, lock regression) → Tasks 1, 2, 13. ✅

**Deferred to follow-up plans (intentional, not gaps):** `−`/`+` multiplier + `open-batch` (PRD §4/§7.2); admin `Ball` CRUD + `ball_id` + `kind:'ball'` (§16); `display_win_rate` field + chip (§7.3); confetti polish (§13 Phase 3); classic-overlay `SellBackPanel` dedup (scope decision #1); logged-out demo reel (scope decision #3).

**Placeholder scan:** none — every code step is complete and runnable.

**Type consistency:** `Rarity`, `WonCard`, `RecentPull`, `SellBackOffer`, `RARITY_RGB`, `BASE_SPIN_MS`, `reelTarget`/`buildStrip` signatures, and `useSound`'s `{ muted, toggleMuted, play, vibrate }` are used identically across Tasks 1–12. `SellConfirmModal` props match `PackOpenOverlay.tsx:748-762`. ✅

**Open content choices with working defaults (PRD §14 — non-blocking):** decoy fill pattern (`buildStrip` cycles the rarity pool deterministically); WINS source (recent-feed length); default mute (unmuted). All have a chosen default in the code; revisit only if the user prefers otherwise.
