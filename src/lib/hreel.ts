// Pure horizontal-reel strip logic: winner pinning, deterministic decoy tier
// colors (the spin flicker), the gated near-miss tease (spec §7b), and the
// press-spin strip (buildPressStrip). No DOM, no React — see
// src/lib/__tests__/hreel.test.ts. Physics (pressSpinOffset, blur, timing)
// stays in vault-reel.ts.
import type { PackCard, Rarity } from '@/lib/packs-data';
import { RARITY_ORDER, isTopRarity } from '@/lib/rarity';
import { POKEDEX_MAX } from '@/lib/reel';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';

/** IDLE-strip build parameter only (spins pick their winner index dynamically
 *  from the live position — see buildPressStrip). The idle build ignores the
 *  winner slot entirely, keeping the strip a pure periodic tiling. */
export const HREEL_WIN_INDEX = 48;
export const HREEL_STRIP_LEN = 64;
/** Cells visible across a strip window — a long horizontal reel. */
export const HREEL_VISIBLE_CELLS = 9;
/** Cell the idle drift starts centered on. Must clear the left half-window
 *  (HREEL_VISIBLE_CELLS/2), and leaves the rest of the strip as drift runway. */
export const HREEL_IDLE_BASE_INDEX = 5;
/** Largest decoy pool the idle drift can wrap over: the drift tiles one full
 *  pool period plus the visible window onto the strip, so a pool beyond
 *  STRIP_LEN − VISIBLE − BASE cells overruns it and ReelStrip rests the reel
 *  sharp — the "rails frozen" bug on big packs (prod diamond-pack: 78 pairs).
 *  Pool builders slice their shuffled pools to this cap; the per-idle-cycle
 *  reshuffle still rotates the full pool through the reel over time. */
export const HREEL_IDLE_POOL_MAX =
  HREEL_STRIP_LEN - HREEL_VISIBLE_CELLS - HREEL_IDLE_BASE_INDEX;

/** True when a pool of `poolLen` cells can wrap the idle drift on the strip:
 *  the drift tiles one full pool period + the visible window from the base
 *  cell. ReelStrip rests the reel sharp when this fails — the shared guard, so
 *  the cap above and the component can never disagree. */
export function idleDriftFits(poolLen: number): boolean {
  return (
    HREEL_IDLE_BASE_INDEX + HREEL_VISIBLE_CELLS + poolLen <= HREEL_STRIP_LEN
  );
}
/** Fallback decoy sprites when the caller supplies no pack pool: a curated set
 *  of dexes that reliably have animated showdown sprites (gen 1–4), so decoy
 *  cells never 404 into a broken image. Used only when the pack pool is empty or
 *  yields no resolvable dex — normally the reel flickers the PACK's own cards
 *  (see buildHReelStrip's `decoyCards`), so decoys are always Pokémon tied to a
 *  reward in this pack, never arbitrary species. */
export const DECOY_DEXES = [1, 4, 7, 25, 6, 9, 3, 143, 94, 130, 448, 197];

/** Neutral card-back (vector, so it stays crisp under the reel's pixelated
 *  scaling): the sprite a non-Pokémon pack shows when a card has none — never
 *  a Pokémon, never a Poké Ball. */
export const NEUTRAL_CARD_SPRITE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='22' y='9' width='56' height='82' rx='7' fill='#262626' stroke='#a3a3a3' stroke-width='3'/><rect x='30' y='17' width='40' height='66' rx='4' fill='none' stroke='#525252' stroke-width='2'/><path d='M50 36 62 50 50 64 38 50Z' fill='#d4d4d4'/></svg>",
  );

/** A reel cell. `image` is set only for a card with a custom sprite and NO
 *  Pokémon (One Piece characters): it is what the cell draws, and `dex` is then
 *  0 (no species). Pokémon cells keep drawing their dex sprite as before.
 *  `label` is a ticket row's amount, drawn over the art as live text. */
export type HReelCell = {
  dex: number;
  rarity: Rarity;
  image?: string;
  label?: string;
};

/** The amount a ticket tile shows. */
export const ticketReelLabel = (tickets: number): string => `x${tickets}`;

/** Cell identity for the no-adjacent-repeat checks: the species when there is
 *  one (a seeded-linked winner carries BOTH its dex and an image URL, and must
 *  still match the dex-only decoys of the same Pokémon), else the custom image —
 *  so two different dex-less sprites (both dex 0) never count as a repeat. Every
 *  ticket tile shares one image, so only its amount tells it apart. */
const spriteOf = (
  c: Pick<HReelCell, 'dex' | 'image' | 'label'>,
): number | string => c.label ?? (c.dex > 0 ? c.dex : (c.image ?? c.dex));

/**
 * Decoy flicker pool from the pack's OWN cards: each entry pairs a card's
 * resolved Pokémon with its CONFIGURED rarity, deduped by the (dex, rarity)
 * PAIR — not by dex alone. A pack of 15 Pikachu/Charizard variants across all
 * six tiers must flicker all six tier colors; dedup-by-dex used to collapse it
 * to the first card per species (2 entries → only 2 glow colors all spin).
 * A dex-less card with a custom sprite (One Piece) flickers that sprite, keyed
 * by its URL; one with neither (trainer/energy) is skipped. Without this a
 * One Piece pack's pool came out empty and the reel fell back to DECOY_DEXES —
 * Pokémon in a One Piece pack.
 *
 * `pokemon: false` (a One Piece / sports pack — see isPokemonPack) never
 * resolves a Pokémon, and a pool with nothing to show falls back to the neutral
 * card-back instead of the Pokémon DECOY_DEXES.
 */
export function buildDecoyPool(
  cards: readonly Pick<
    PackCard,
    'name' | 'set' | 'pokemonDex' | 'spriteImage' | 'rarity' | 'tickets'
  >[],
  { pokemon = true }: { pokemon?: boolean } = {},
): HReelCell[] {
  const seen = new Set<string>();
  const out: HReelCell[] = [];
  for (const c of cards) {
    if (c.tickets != null) {
      // One row per amount (the backend's unique index), so nothing to dedupe,
      // and no name to read a Pokémon out of.
      out.push({
        dex: 0,
        rarity: c.rarity,
        image: c.spriteImage ?? undefined,
        label: ticketReelLabel(c.tickets),
      });
      continue;
    }
    const { dex, sprite } = resolveCardPokemon(
      {
        name: c.name,
        set: c.set,
        pokemon_dex: c.pokemonDex,
        sprite_image: c.spriteImage,
      },
      { pokemon },
    );
    if (dex === null && sprite === null) continue;
    // A card's own custom sprite flickers as itself (a variant row, a custom
    // upload), species or not; a card without one keeps the stock dex cell.
    const custom = c.spriteImage?.trim() ? c.spriteImage : null;
    const cell: HReelCell =
      custom !== null
        ? { dex: dex ?? 0, rarity: c.rarity, image: custom }
        : dex !== null
          ? { dex, rarity: c.rarity }
          : { dex: 0, rarity: c.rarity, image: sprite! };
    // Dedup by the exact sprite: two variants of one species in a tier stay
    // two decoys (the repeat checks still key on the species — spriteOf).
    const key = `${cell.dex}:${cell.image ?? ''}:${c.rarity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cell);
  }
  if (!pokemon && out.length === 0) {
    // Six cycled tier colours so the spin still flickers.
    return RARITY_ORDER.map((_, i) => ({
      dex: 0,
      rarity: decoyRarity(i),
      image: NEUTRAL_CARD_SPRITE,
    }));
  }
  return out;
}

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

/**
 * One idle-cycle pool for a reel: a fresh shuffle of the base pool, capped to
 * HREEL_IDLE_POOL_MAX so the idle drift always fits the strip (the frozen-rails
 * bug: an uncapped 78-pair pool made ReelStrip rest the reel sharp). Shuffling
 * BEFORE the slice is what rotates the full pool through the reel across
 * cycles. `rand` is injectable for deterministic tests.
 */
export function buildIdlePool(
  cells: readonly HReelCell[],
  rand: () => number = Math.random,
): HReelCell[] {
  return shuffleCells(cells, rand).slice(0, HREEL_IDLE_POOL_MAX);
}

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

/** Deterministic 32-bit PRNG (mulberry32) — seeds the per-spin decoy shuffle so
 *  a spin's strip is stable across React re-renders but different every spin. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the strip for a PRESS-launched spin — the spin that starts from the
 * live idle drift instead of a fresh paint:
 *   • cells [0, keepCells) reproduce the idle tiling EXACTLY (same formula as
 *     buildHReelStrip's idle branch), so swapping the strip in at press time
 *     changes nothing on screen — the launch is seamless;
 *   • cells beyond that (the runway the spin streams through) are drawn
 *     RANDOMLY from the pool via `rngSeed` (no adjacent repeats), so the reel
 *     never shows the tiling's 1-2-3 sequence at speed and no two spins route
 *     the same;
 *   • the winner is pinned at `winIndex` with the gated near-miss tease at
 *     `winIndex - 1` (spec §7b), exactly like buildHReelStrip.
 * `winIndex` is dynamic — the caller picks it from the strip's live position so
 * the travel distance always fits the physics (see pressTravelPx).
 */
export function buildPressStrip({
  winnerDex,
  winnerImage,
  winnerLabel,
  winnerRarity,
  winIndex,
  keepCells,
  seed,
  rngSeed,
  decoyCards = [],
}: {
  winnerDex: number | null;
  /** The won card's custom sprite, when it has one (ReelStrip draws it). */
  winnerImage?: string;
  /** A ticket win's amount, drawn over the art. */
  winnerLabel?: string;
  winnerRarity: Rarity;
  winIndex: number;
  keepCells: number;
  /** Idle tiling seed — MUST match the idle strip's (the reel index). */
  seed: number;
  /** Per-spin randomness (spin nonce ⊕ column). */
  rngSeed: number;
  decoyCards?: readonly HReelCell[];
}): HReelCell[] {
  if (!Number.isInteger(winIndex) || winIndex < 1) {
    throw new RangeError(
      'buildPressStrip: winIndex must be a positive integer',
    );
  }
  if (!Number.isInteger(keepCells) || keepCells < 0 || keepCells >= winIndex) {
    throw new RangeError(
      'buildPressStrip: keepCells must be within [0, winIndex)',
    );
  }
  const pool: readonly HReelCell[] =
    decoyCards.length > 0
      ? decoyCards
      : DECOY_DEXES.map((dex, i) => ({ dex, rarity: decoyRarity(i) }));
  // Enough tail past the winner to fill the window's right half when it lands.
  const length = winIndex + Math.ceil(HREEL_VISIBLE_CELLS / 2) + 2;
  const validDex =
    winnerDex !== null &&
    Number.isInteger(winnerDex) &&
    winnerDex >= 1 &&
    winnerDex <= POKEDEX_MAX
      ? winnerDex
      : null;
  // A custom-sprite winner shows its own image (dex 0 if it has no species);
  // garbage with no image falls back to the first POOL cell, sprite and all.
  const winnerCell: HReelCell = winnerImage
    ? {
        dex: validDex ?? 0,
        rarity: winnerRarity,
        image: winnerImage,
        ...(winnerLabel ? { label: winnerLabel } : {}),
      }
    : validDex !== null
      ? { dex: validDex, rarity: winnerRarity }
      : { ...pool[0]!, rarity: winnerRarity };
  const rand = mulberry32(rngSeed);
  const cells: HReelCell[] = [];
  for (let i = 0; i < length; i++) {
    if (i < keepCells) {
      // Idle tiling, verbatim — what is already on screen at press time.
      cells.push({ ...pool[(i + seed * 4) % pool.length]! });
      continue;
    }
    if (i === winIndex) {
      // Pin the winner INLINE so the neighbor rerolls below can see it — a
      // post-loop overwrite let winIndex±1 double the winner's sprite at the
      // most-watched moment (the landing).
      cells.push(winnerCell);
      continue;
    }
    let c = pool[Math.floor(rand() * pool.length)]!;
    // Reroll immediate sprite repeats — a doubled cell reads as a stutter at
    // speed. cells[i-1] covers the winner's RIGHT neighbor (the winner is
    // already pushed); the LEFT neighbor must also reject the winner's sprite
    // ahead of time. Bounded tries so a single-entry pool can't loop forever.
    const prev = cells[i - 1];
    const prevSprite = prev ? spriteOf(prev) : undefined;
    const winnerAhead = i === winIndex - 1 ? spriteOf(winnerCell) : undefined;
    const blocked = (p: HReelCell) =>
      spriteOf(p) === prevSprite || spriteOf(p) === winnerAhead;
    for (let tries = 0; tries < 4 && blocked(c); tries++) {
      c = pool[Math.floor(rand() * pool.length)]!;
    }
    if (blocked(c)) {
      // Small pools can exhaust the tries; pick deterministically rather than
      // give up — doubling the WINNER's sprite at the landing is the artifact
      // that matters most, so prefer avoiding both, then at least the winner.
      // When only the previous cell's repeat is unavoidable (every cell shares
      // one sprite — the neutral card-back pool), keep the random pick: the
      // first pool cell every time would spin a single tier colour.
      c =
        pool.find((p) => !blocked(p)) ??
        (spriteOf(c) !== winnerAhead
          ? c
          : pool.find((p) => spriteOf(p) !== winnerAhead)) ??
        c;
    }
    cells.push({ ...c });
  }
  const tease = teaseRarity(winnerRarity);
  if (tease && winIndex - 1 >= 0) {
    cells[winIndex - 1] = { ...cells[winIndex - 1]!, rarity: tease };
  }
  return cells;
}

/**
 * Build a horizontal strip: winner dex pinned at `winIndex` (its cell carries a
 * DECOY color — the real tier is applied by the component on settle, so the
 * spin never spoils the rarity), a gated near-miss tease at `winIndex-1`
 * (the last decoy to cross the line before the winner), decoys elsewhere.
 *
 * `decoyCards` is the pool the flicker cells sample from — pass the PACK's own
 * cards, each PAIRING its dex with its CONFIGURED rarity, so the reel only shows
 * Pokémon tied to a reward in this pack AND only glows the pack's actual rarity
 * colors (a card set to Immortal always glows Immortal; a pack with only
 * Immortal + Common never flickers Legendary/Mythical/Rare/Uncommon). Empty/
 * omitted → the curated DECOY_DEXES with cycled colors (fallback only).
 */
export function buildHReelStrip(
  winnerDex: number | null,
  winnerRarity: Rarity,
  length: number,
  winIndex: number,
  seed = 0,
  decoyCards: readonly HReelCell[] = [],
): HReelCell[] {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('buildHReelStrip: length must be a positive integer');
  }
  if (!Number.isInteger(winIndex) || winIndex < 0 || winIndex >= length) {
    throw new RangeError(
      'buildHReelStrip: winIndex must be within [0, length)',
    );
  }
  // The pack's own cards (dex + configured rarity, paired) drive the decoys. A
  // pack with no resolvable card dexes (empty pool) falls back to the curated
  // dexes with cycled colors so decoys never render broken images.
  const pool: readonly HReelCell[] =
    decoyCards.length > 0
      ? decoyCards
      : DECOY_DEXES.map((dex, i) => ({ dex, rarity: decoyRarity(i) }));
  // `seed` (the reel index) shifts the decoy pattern so stacked strips show
  // DIFFERENT flanking Pokémon + tier colors — three independent-looking reels,
  // not one repeated ×3. seed=0 keeps the original single-strip behavior. Each
  // cell keeps its card's OWN rarity (its box color), not a cycled palette.
  const cells: HReelCell[] = Array.from({ length }, (_, i) => ({
    ...pool[(i + seed * 4) % pool.length]!,
  }));
  // `winnerDex === null` = IDLE (no spin yet): leave the strip a PURE tiling of
  // the pool, so it is exactly periodic with period `pool.length` cells. That
  // periodicity is what makes ReelStrip's idle drift wrap seamlessly — a pinned
  // winner or tease cell in the drift path would show as a seam once per loop.
  if (winnerDex !== null) {
    // Winner: real dex (fall back to a POOL dex — never a hardcoded 1 — if the
    // caller passes garbage), DECOY color from a pool card (the real color is
    // applied on settle by ReelStrip, so the spin never spoils the rarity).
    // (The fallback copies the pool cell's whole sprite — a custom-sprite cell
    // is dex 0 + image, and dex 0 alone would draw nothing.)
    const winner: Pick<HReelCell, 'dex' | 'image'> =
      Number.isInteger(winnerDex) && winnerDex >= 1 && winnerDex <= POKEDEX_MAX
        ? { dex: winnerDex }
        : pool[0]!;
    cells[winIndex] = {
      ...winner,
      rarity: pool[(winIndex + seed) % pool.length]!.rarity,
    };
    const tease = teaseRarity(winnerRarity);
    const teaseIdx = winIndex - 1;
    if (tease && teaseIdx >= 0) {
      cells[teaseIdx] = { ...cells[teaseIdx]!, rarity: tease };
    }
  }
  return cells;
}
