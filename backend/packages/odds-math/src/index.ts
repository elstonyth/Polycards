// Rarity-weighted odds math — the single source of truth shared by the backend
// save workflow (authoritative) and the admin win-rate editor's live preview.
// Pure + dependency-free. Both consumers import this exact module, so the
// preview can never drift from what gets persisted.
//
// Model: each pack's PackOdds weights are normalized to BASIS POINTS that sum to
// exactly TOTAL_BPS (= 10000 = 100%), so weight/100 reads back as the win %.
//   - LOCKED cards keep the operator's chosen % verbatim.
//   - UNLOCKED cards split the leftover (10000 − Σlocked) bps PROPORTIONALLY to
//     their per-pack rarity weight (see RARITY_WEIGHT), with largest-remainder
//     rounding (fraction ties broken by lowest card_id) so the total is exactly
//     10000 regardless of input order.

export const TOTAL_BPS = 10000;

// Per-pack rarity tiers, rarest first. Rarity belongs to the pack↔card link
// (PackOdds), not the card — the same card can be a different tier per pack.
// `Immortal` is the apex tier (rarer than Legendary).
export const RARITIES = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
] as const;

export type OddsRarity = (typeof RARITIES)[number];

// Relative pull weight per tier (rarest = smallest). Choosing a rarity directly
// sets the unlocked card's default win chance; locking a % still overrides it.
export const RARITY_WEIGHT: Record<OddsRarity, number> = {
  Immortal: 1,
  Legendary: 5,
  Mythical: 45,
  Rare: 150,
  Uncommon: 300,
  Common: 500,
};

// Tolerant lookup (never throws): unknown strings fall back to Common so a
// stale form or legacy row degrades gracefully instead of breaking the preview.
const rarityWeight = (rarity: string): number =>
  RARITY_WEIGHT[rarity as OddsRarity] ?? RARITY_WEIGHT.Common;

export interface OddsInput {
  card_id: string;
  locked: boolean;
  /** Win % (0–100) for locked cards. Ignored (recomputed) for unlocked cards. */
  pct: number;
  /** Per-pack tier; sets the unlocked card's share of the leftover bps. */
  rarity: string;
}

export interface ComputedOdd {
  card_id: string;
  /** Basis points (1% = 100 bps). Σ over a pack == TOTAL_BPS when valid. */
  weight: number;
  locked: boolean;
  /** weight / 100 — the resulting win %, for display. */
  pct: number;
}

export interface OddsResult {
  /** Per-card result, in the SAME order as the input. Always populated
   *  (best-effort) so the preview renders even while `error` is set. */
  computed: ComputedOdd[];
  /** Non-null when the configuration is invalid and must NOT be saved. */
  error: string | null;
  /** Σ of locked win rates, as a % (for the form summary). */
  lockedTotalPct: number;
  unlockedCount: number;
}

const clampBps = (bps: number): number => Math.max(0, Math.min(TOTAL_BPS, bps));

/**
 * Compute the normalized per-card odds for a pack from the editor's entries.
 * Never throws — invalid input yields a best-effort `computed` plus a non-null
 * `error` (the workflow rejects on `error`; the form disables Save on `error`).
 */
export function computeOdds(entries: OddsInput[]): OddsResult {
  const safe = Array.isArray(entries) ? entries : [];
  const unlocked = safe.filter((e) => e.locked === false);

  let error: string | null = null;
  let lockedBpsTotal = 0;
  const lockedBpsById = new Map<string, number>();

  for (const e of safe) {
    if (!e.locked) continue;
    const pct = Number(e.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      error ??= 'Each locked win rate must be between 0% and 100%.';
    }
    const bps = clampBps(Math.round((Number.isFinite(pct) ? pct : 0) * 100));
    lockedBpsById.set(e.card_id, bps);
    lockedBpsTotal += bps;
  }

  if (safe.length === 0) error ??= 'No cards to configure.';
  if (lockedBpsTotal > TOTAL_BPS) error ??= 'Locked win rates exceed 100%.';
  if (unlocked.length === 0 && lockedBpsTotal !== TOTAL_BPS) {
    error ??= 'With every card locked, win rates must total exactly 100%.';
  }

  const remainder = Math.max(0, TOTAL_BPS - lockedBpsTotal);
  const totalRarityWeight = unlocked.reduce(
    (sum, e) => sum + rarityWeight(e.rarity),
    0,
  );

  const shareById = new Map<string, number>();
  if (unlocked.length > 0 && totalRarityWeight > 0) {
    const shares = unlocked.map((e) => {
      const raw = (remainder * rarityWeight(e.rarity)) / totalRarityWeight;
      const base = Math.floor(raw);
      return { card_id: e.card_id, base, frac: raw - base };
    });
    let leftover = remainder - shares.reduce((sum, s) => sum + s.base, 0);
    const byFrac = [...shares].sort(
      (a, b) =>
        b.frac - a.frac ||
        (a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0),
    );
    for (const s of byFrac) {
      if (leftover <= 0) break;
      s.base += 1;
      leftover -= 1;
    }
    for (const s of shares) shareById.set(s.card_id, s.base);
  }

  const computed: ComputedOdd[] = safe.map((e) => {
    const weight = e.locked
      ? (lockedBpsById.get(e.card_id) ?? 0)
      : (shareById.get(e.card_id) ?? 0);
    return { card_id: e.card_id, weight, locked: e.locked, pct: weight / 100 };
  });

  return {
    computed,
    error,
    lockedTotalPct: lockedBpsTotal / 100,
    unlockedCount: unlocked.length,
  };
}
