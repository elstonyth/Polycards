// Pure horizontal-reel strip logic: winner pinning, deterministic decoy tier
// colors (the spin flicker), and the gated near-miss tease (spec §7b). No DOM,
// no React — see src/lib/__tests__/hreel.test.ts. Physics (spinOffset, blur,
// timing) stays in vault-reel.ts and is reused unchanged.
import type { Rarity } from '@/lib/packs-data';
import { RARITY_ORDER, isTopRarity } from '@/lib/rarity';
import { POKEDEX_MAX } from '@/lib/reel';

/** Winner index sits high on a LONG strip so the reflected right→left travel
 *  (reelPaintX) has runway and stays in bounds — verified in reel.test.ts. */
export const HREEL_WIN_INDEX = 48;
export const HREEL_STRIP_LEN = 64;
/** Cells visible across a strip window — a long horizontal reel. */
export const HREEL_VISIBLE_CELLS = 9;
/** Fallback decoy sprites when the caller supplies no pack pool: a curated set
 *  of dexes that reliably have animated showdown sprites (gen 1–4), so decoy
 *  cells never 404 into a broken image. Used only when the pack pool is empty or
 *  yields no resolvable dex — normally the reel flickers the PACK's own cards
 *  (see buildHReelStrip's `decoyDexes`), so decoys are always Pokémon tied to a
 *  reward in this pack, never arbitrary species. */
export const DECOY_DEXES = [1, 4, 7, 25, 6, 9, 3, 143, 94, 130, 448, 197];

export type HReelCell = { dex: number; rarity: Rarity };

/**
 * Deterministic decoy tier for cell `i`: a prime-step walk over the 6-tier
 * palette so the strip flickers varied colors with zero render-time randomness.
 * `(i*5+2) % 6` visits all six tiers with period 6.
 */
export function decoyRarity(i: number): Rarity {
  return RARITY_ORDER[(i * 5 + 2) % RARITY_ORDER.length]!;
}

/**
 * Near-miss tease tier, GATED to the real win (spec §7b): a top win teases its
 * OWN tier (the prize approaches the line, then lands → big-win blast); a mid
 * win teases ONE tier up; a Common win gets NO faked near-miss (null → the
 * cell stays a normal decoy). Keeps "anticipation tease" from becoming the
 * declined "fake near-miss on small wins".
 */
export function teaseRarity(winner: Rarity): Rarity | null {
  if (isTopRarity(winner)) return winner;
  if (winner === 'Common') return null;
  const up = RARITY_ORDER.indexOf(winner) - 1; // one step toward the top
  return RARITY_ORDER[Math.max(0, up)]!;
}

/**
 * Build a horizontal strip: winner dex pinned at `winIndex` (its cell carries a
 * DECOY color — the real tier is applied by the component on settle, so the
 * spin never spoils the rarity), a gated near-miss tease at `winIndex-1`
 * (the last decoy to cross the line before the winner), decoys elsewhere.
 *
 * `decoyDexes` is the pool the flicker cells sample from — pass the PACK's own
 * card dexes so the reel only shows Pokémon tied to a reward in this pack (the
 * reported bug was arbitrary hardcoded species). Empty/omitted → DECOY_DEXES.
 */
export function buildHReelStrip(
  winnerDex: number | null,
  winnerRarity: Rarity,
  length: number,
  winIndex: number,
  seed = 0,
  decoyDexes: readonly number[] = DECOY_DEXES,
): HReelCell[] {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('buildHReelStrip: length must be a positive integer');
  }
  if (!Number.isInteger(winIndex) || winIndex < 0 || winIndex >= length) {
    throw new RangeError(
      'buildHReelStrip: winIndex must be within [0, length)',
    );
  }
  // A pack with no resolvable card dexes (empty pool) falls back to the curated
  // set so decoys never render broken images.
  const pool = decoyDexes.length > 0 ? decoyDexes : DECOY_DEXES;
  // Winner cell: the real winner dex, else a POOL dex (never a hardcoded 1) so
  // the IDLE strip (no winner yet) stays entirely pack-configured Pokémon.
  const safeWinner =
    winnerDex !== null &&
    Number.isInteger(winnerDex) &&
    winnerDex >= 1 &&
    winnerDex <= POKEDEX_MAX
      ? winnerDex
      : pool[0]!;
  // `seed` (the reel index) shifts the decoy pattern so stacked strips show
  // DIFFERENT flanking Pokémon + tier colors — three independent-looking reels,
  // not one repeated ×3. seed=0 keeps the original single-strip behavior.
  const cells: HReelCell[] = Array.from({ length }, (_, i) => ({
    dex: pool[(i + seed * 4) % pool.length]!,
    rarity: decoyRarity(i + seed),
  }));
  // Winner: real dex, DECOY color (real color applied on settle by ReelStrip).
  cells[winIndex] = { dex: safeWinner, rarity: decoyRarity(winIndex + seed) };
  const tease = teaseRarity(winnerRarity);
  const teaseIdx = winIndex - 1;
  if (tease && teaseIdx >= 0) {
    cells[teaseIdx] = { ...cells[teaseIdx]!, rarity: tease };
  }
  return cells;
}
