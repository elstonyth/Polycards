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
  /** Σ of locked win rates, as a % (for the form summary). NOTE: under
   *  `balanceOdds` this is the PINNED total (every non-Common row plus locked
   *  Commons — its "locked" set), not just `locked: true` rows; `computeOdds`
   *  keeps the literal meaning. No consumer reads it today — rename to a
   *  separate pinnedTotalPct if one ever needs both. */
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

// ── Common as balancer (POLYCARD-BACK §2.4) ─────────────────────────────────
// Replaces the rarity-weighted remainder split FOR PACK-ODDS SAVES: every
// non-Common row keeps its submitted pct verbatim (locked or not), locked
// Common rows are pinned too, and UNLOCKED Common rows absorb the remainder
// (even split, largest-remainder rounding → Σ === TOTAL_BPS exactly,
// input-order independent). computeOdds above STAYS for the reward/daily-box
// editors — those pools have no Common-as-balancer concept.
export function balanceOdds(entries: OddsInput[]): OddsResult {
  const safe = Array.isArray(entries) ? entries : [];
  let error: string | null = null;

  const isBalancer = (entry: OddsInput): boolean =>
    entry.locked === false && entry.rarity === 'Common';
  const pinned = safe.filter((entry) => !isBalancer(entry));
  const balancers = safe.filter(isBalancer);

  let pinnedBps = 0;
  const bpsById = new Map<string, number>();
  for (const entry of pinned) {
    const pct = Number(entry.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      error ??= 'Each win rate must be between 0% and 100%.';
    }
    const bps = clampBps(Math.round((Number.isFinite(pct) ? pct : 0) * 100));
    bpsById.set(entry.card_id, bps);
    pinnedBps += bps;
  }

  if (safe.length === 0) error ??= 'No cards to configure.';
  if (pinnedBps > TOTAL_BPS) {
    error ??= 'Common win rate would go below 0%. Lower the other rates.';
  }
  if (balancers.length === 0 && pinnedBps !== TOTAL_BPS) {
    error ??=
      'Without an unlocked Common card, win rates must total exactly 100%.';
  }

  const remainder = Math.max(0, TOTAL_BPS - pinnedBps);
  if (balancers.length > 0) {
    const base = Math.floor(remainder / balancers.length);
    let leftover = remainder - base * balancers.length;
    const ordered = [...balancers].sort((a, b) =>
      a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0,
    );
    for (const entry of ordered) {
      bpsById.set(entry.card_id, base + (leftover > 0 ? 1 : 0));
      if (leftover > 0) leftover -= 1;
    }
  }

  const computed: ComputedOdd[] = safe.map((entry) => {
    const weight = bpsById.get(entry.card_id) ?? 0;
    return {
      card_id: entry.card_id,
      weight,
      locked: entry.locked,
      pct: weight / 100,
    };
  });

  return {
    computed,
    error,
    lockedTotalPct: pinnedBps / 100,
    unlockedCount: balancers.length,
  };
}

// ── Win-rate SETS 2 and 3 (POLYCARD-BACK §2.4 / D2) ─────────────────────────
// One pack carries three odds tables; a customer's group picks which one their
// spin rolls against (set 1 = default). Sets 2/3 are stored SPARSELY: a NULL
// weight_2/weight_3 means "inherit the previous set" for that card (3→2→1).
//
// STORAGE RULE (the invariant this function encodes):
//   - Set 1 ALWAYS materializes (`weight` on every row).
//   - For set s ∈ {2,3}: if NO entry carries an explicit `pct_s`, the whole set
//     stays NULL — pure inheritance, and Σ is already guaranteed by set 1.
//     Otherwise the set's EFFECTIVE rates (explicit `pct_s`, else the PREVIOUS
//     set's resolved pct — so 3 chains off 2, not off 1) run through
//     `balanceOdds`, and `weight_s` is stored for (a) every card with an
//     explicit `pct_s` and (b) every unlocked Common (the balancer output).
//     Cards that merely inherited stay NULL.
//   - Because every save recomputes ALL THREE sets, a later set-1 edit
//     refreshes the materialized Common of sets 2/3 — so each set's RESOLVED
//     weights sum to exactly TOTAL_BPS after every save.
//
// Errors are per-set and short-circuit: set 1's message propagates verbatim,
// sets 2/3 are prefixed 'Set N: ' so the editor can point at the right tab.

/** An editor row: set-1 `pct` plus the optional per-set overrides (null = inherit). */
export type SetEntry = OddsInput & {
  pct_2: number | null;
  pct_3: number | null;
};

export type SetWeightsResult = {
  /** First error encountered, prefixed 'Set N: ' for sets 2/3. Non-null ⇒ do NOT save. */
  error: string | null;
  /** Per-card storage row, in input order. Empty when `error` is set. */
  rows: {
    card_id: string;
    locked: boolean;
    /** Set 1 basis points — always materialized. */
    weight: number;
    /** Basis points for set 2/3; null = inherit the previous set. */
    weight_2: number | null;
    weight_3: number | null;
  }[];
};

export function computeSetWeights(entries: SetEntry[]): SetWeightsResult {
  const set1 = balanceOdds(entries);
  if (set1.error) return { error: set1.error, rows: [] };

  const pctByCard = (r: OddsResult): Map<string, number> =>
    new Map(r.computed.map((c) => [c.card_id, c.pct]));

  // Keyed lookup instead of a linear `entries.find` per computed row PER SET:
  // this runs on every editor keystroke (previewSets) over pools the rest of
  // the code sizes at 2000+ rows. First occurrence wins, exactly as `find` did.
  const byCard = new Map<string, SetEntry>();
  for (const e of entries) if (!byCard.has(e.card_id)) byCard.set(e.card_id, e);

  let prev = pctByCard(set1);
  const materialized: (Map<string, number> | null)[] = [];

  for (const setNo of [2, 3] as const) {
    const explicit = (e: SetEntry): number | null =>
      setNo === 2 ? e.pct_2 : e.pct_3;

    // No override anywhere ⇒ the whole set inherits; store nothing.
    if (!entries.some((e) => explicit(e) !== null)) {
      materialized.push(null);
      continue;
    }

    const eff: OddsInput[] = entries.map((e) => ({
      card_id: e.card_id,
      locked: e.locked,
      rarity: e.rarity,
      pct: explicit(e) ?? prev.get(e.card_id) ?? 0,
    }));

    const r = balanceOdds(eff);
    if (r.error) return { error: `Set ${setNo}: ${r.error}`, rows: [] };

    const weights = new Map<string, number>();
    for (const c of r.computed) {
      const src = byCard.get(c.card_id);
      if (!src) continue;
      const isBalancer = src.locked === false && src.rarity === 'Common';
      if (explicit(src) !== null || isBalancer)
        weights.set(c.card_id, c.weight);
    }
    materialized.push(weights);
    prev = pctByCard(r);
  }

  const [m2, m3] = materialized;
  const w1 = new Map(set1.computed.map((c) => [c.card_id, c.weight]));

  return {
    error: null,
    rows: entries.map((e) => ({
      card_id: e.card_id,
      locked: e.locked,
      weight: w1.get(e.card_id) ?? 0,
      weight_2: m2 ? (m2.get(e.card_id) ?? null) : null,
      weight_3: m3 ? (m3.get(e.card_id) ?? null) : null,
    })),
  };
}

// ── Rarity proposal (auto-split support) ────────────────────────────────────
// Tier a card by its value as a MULTIPLE OF THE TICKET, so the mapping is
// explainable and stays stable as prices drift. Pure: the caller supplies
// display prices (FMV x fx x markup); odds-math never reads the DB.

export interface RarityProposalRow {
  card_id: string;
  /** MYR display price (FMV x fx x per-card multiplier). */
  value: number;
}

export interface RarityProposal {
  card_id: string;
  rarity: OddsRarity;
}

// EXCLUSIVE upper bound of each tier as a multiple of pack price; anything at
// or above the last bound is Immortal.
const RARITY_BANDS: { max: number; rarity: OddsRarity }[] = [
  { max: 2, rarity: 'Common' },
  { max: 10, rarity: 'Uncommon' },
  { max: 50, rarity: 'Rare' },
  { max: 150, rarity: 'Mythical' },
  { max: 400, rarity: 'Legendary' },
];

export function proposeRarities(
  rows: RarityProposalRow[],
  packPrice: number,
): RarityProposal[] {
  const priceOk = Number.isFinite(packPrice) && packPrice > 0;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const value = Number(row.value);
    // Unusable inputs degrade to Common rather than throwing — a stale form
    // must not break the editor's preview.
    if (!priceOk || !Number.isFinite(value) || value < 0) {
      return { card_id: row.card_id, rarity: 'Common' as OddsRarity };
    }
    const multiple = value / packPrice;
    const band = RARITY_BANDS.find((b) => multiple < b.max);
    return { card_id: row.card_id, rarity: band ? band.rarity : 'Immortal' };
  });
}

// ── Target-RTP auto-split (POLYCARD-BACK auto-split spec) ───────────────────
// Solve a single CHASE BUDGET `c` — the total probability mass across unlocked
// non-Common rows. Inside the budget the rarity ladder's relative proportions
// are preserved exactly; unlocked Commons absorb the rest. EV is LINEAR in `c`,
// so this is a closed form, not a search.
//
// Rejected alternative: exponentiating the ladder. It hits the target but
// collapses the tail (bronze-pack needs k ~ 6.15, pushing Legendary to 1 in
// 4 trillion), which defeats the point of a chase card.

/** Smallest storable non-zero win rate: 1 bps. */
export const MIN_PCT = 100 / TOTAL_BPS;

export interface RtpSolveRow {
  card_id: string;
  locked: boolean;
  rarity: string;
  /** MYR display price (FMV x fx x per-card multiplier). */
  value: number;
  /** Pinned win % (0-100). Read ONLY when `locked`. */
  pct: number;
}

export interface FlooredRow {
  card_id: string;
  /** The rate the solve wanted (%), below the 1 bps floor. */
  fairPct: number;
  /** What it was pinned to instead — always MIN_PCT. */
  appliedPct: number;
}

export interface RtpSolveResult {
  /** Non-null => do NOT apply. */
  error: string | null;
  /** Win % (0-100) per card, INPUT ORDER. Empty when `error` is set. */
  computed: { card_id: string; pct: number }[];
  /** Chase rows pinned up to the floor. Empty when nothing floored. */
  floored: FlooredRow[];
  /** Tiers whose every chase row sits at the floor (only when >= 2 tiers). */
  tierCollapse: OddsRarity[];
  /** Achieved RTP as a FRACTION (0.703 = 70.3%); null when `error`. */
  achievedRtp: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Ladder-weighted mean value; 0 for an empty group. */
const ladderMean = (rows: RtpSolveRow[]): number => {
  const w = rows.reduce((s, r) => s + rarityWeight(r.rarity), 0);
  if (w <= 0) return 0;
  return rows.reduce((s, r) => s + rarityWeight(r.rarity) * r.value, 0) / w;
};

/** Spread `c` over the free chase rows and `M - c` over the absorbers. */
const distribute = (
  all: RtpSolveRow[],
  chaseFree: RtpSolveRow[],
  absorbers: RtpSolveRow[],
  fixedPct: Map<string, number>,
  c: number,
  M: number,
): { card_id: string; pct: number }[] => {
  const wH = chaseFree.reduce((s, r) => s + rarityWeight(r.rarity), 0);
  const wC = absorbers.reduce((s, r) => s + rarityWeight(r.rarity), 0);
  const byId = new Map<string, number>(fixedPct);
  for (const r of chaseFree) {
    byId.set(r.card_id, wH > 0 ? (100 * c * rarityWeight(r.rarity)) / wH : 0);
  }
  for (const r of absorbers) {
    byId.set(r.card_id, wC > 0 ? (100 * (M - c) * rarityWeight(r.rarity)) / wC : 0);
  }
  return all.map((r) => ({ card_id: r.card_id, pct: byId.get(r.card_id) ?? 0 }));
};

const rtpOf = (
  computed: { card_id: string; pct: number }[],
  byId: Map<string, RtpSolveRow>,
  packPrice: number,
): number =>
  computed.reduce(
    (s, c) => s + (c.pct / 100) * (byId.get(c.card_id)?.value ?? 0),
    0,
  ) / packPrice;

export function solveOddsForRtp(
  rows: RtpSolveRow[],
  packPrice: number,
  targetRtp: number,
): RtpSolveResult {
  const fail = (error: string): RtpSolveResult => ({
    error,
    computed: [],
    floored: [],
    tierCollapse: [],
    achievedRtp: null,
  });

  const safe = Array.isArray(rows) ? rows : [];
  if (safe.length === 0) return fail('No cards to configure.');
  if (!Number.isFinite(packPrice) || packPrice <= 0) {
    return fail('Pack price must be greater than 0 to solve for RTP.');
  }
  if (!Number.isFinite(targetRtp) || targetRtp <= 0) {
    return fail('Target RTP must be greater than 0%.');
  }
  if (safe.some((r) => !Number.isFinite(r.value) || r.value < 0)) {
    return fail('Every card needs a value of 0 or more.');
  }
  if (safe.some((r) => r.locked && (!Number.isFinite(r.pct) || r.pct < 0 || r.pct > 100))) {
    return fail('Locked win rates must each be a number between 0% and 100%.');
  }

  const locked = safe.filter((r) => r.locked);
  const chase = safe.filter((r) => !r.locked && r.rarity !== 'Common');
  const absorbers = safe.filter((r) => !r.locked && r.rarity === 'Common');

  if (absorbers.length === 0) {
    return fail(
      'No unlocked Common card to absorb the remainder. Set one card to Common and unlock it.',
    );
  }
  if (chase.length === 0) {
    return fail('No unlocked non-Common card to give a chase budget to.');
  }

  const lockedMass = locked.reduce((s, r) => s + r.pct / 100, 0);
  const M = 1 - lockedMass;
  if (M <= 0) {
    return fail('Locked win rates already use the full 100%. Unlock a card to auto-split.');
  }
  const lockedEv = locked.reduce((s, r) => s + (r.pct / 100) * r.value, 0);

  const targetEv = targetRtp * packPrice;
  const vC = ladderMean(absorbers);
  const vH = ladderMean(chase);
  if (vH === vC) {
    return fail(
      'Chase and Common cards have the same average value, so no split changes the RTP.',
    );
  }

  // Solve, floor, re-solve. Flooring consumes mass and EV, which shrinks the
  // next budget and can push further rows under the floor — so iterate until
  // stable. Each pass only ADDS to `flooredIds`, bounded by the row count.
  const flooredIds = new Set<string>();
  const floored: FlooredRow[] = [];
  const byId = new Map(safe.map((r) => [r.card_id, r]));
  let computed: { card_id: string; pct: number }[] | null = null;
  let bandError: string | null = null;

  for (let pass = 0; pass <= chase.length; pass += 1) {
    const free = chase.filter((r) => !flooredIds.has(r.card_id));
    const flooredMass = (flooredIds.size * MIN_PCT) / 100;
    const flooredEv = chase
      .filter((r) => flooredIds.has(r.card_id))
      .reduce((s, r) => s + (MIN_PCT / 100) * r.value, 0);

    const mFree = M - flooredMass;
    if (mFree <= 0) {
      bandError =
        'Too many cards need the 1 in 10,000 minimum to fit in 100%. Remove cards from the pool.';
      break;
    }

    const fixedPct = new Map<string, number>(locked.map((r) => [r.card_id, r.pct]));
    for (const id of flooredIds) fixedPct.set(id, MIN_PCT);

    // Every chase row floored: the absorbers simply take what is left.
    if (free.length === 0) {
      computed = distribute(safe, [], absorbers, fixedPct, 0, mFree);
      break;
    }

    const vHFree = ladderMean(free);
    if (vHFree === vC) {
      bandError =
        'Chase and Common cards have the same average value, so no split changes the RTP.';
      break;
    }

    const cFree = (targetEv - lockedEv - flooredEv - mFree * vC) / (vHFree - vC);
    if (cFree < 0 || cFree > mFree) {
      const a = lockedEv + flooredEv + mFree * vC;
      const b = lockedEv + flooredEv + mFree * vH;
      const minEv = Math.min(a, b);
      const maxEv = Math.max(a, b);
      bandError =
        `Target ${round2(targetRtp * 100)}% needs EV RM ${round2(targetEv)}; ` +
        `this pool reaches RM ${round2(minEv)}-RM ${round2(maxEv)} ` +
        `(${round2((minEv / packPrice) * 100)}%-${round2((maxEv / packPrice) * 100)}%). ` +
        'Lower the target, raise the price, or change the pool.';
      break;
    }

    const trial = distribute(safe, free, absorbers, fixedPct, cFree, mFree);
    const trialPct = new Map(trial.map((t) => [t.card_id, t.pct]));
    const below = free.filter((r) => (trialPct.get(r.card_id) ?? 0) < MIN_PCT);

    if (below.length === 0) {
      computed = trial;
      break;
    }
    for (const r of below) {
      floored.push({
        card_id: r.card_id,
        fairPct: trialPct.get(r.card_id) ?? 0,
        appliedPct: MIN_PCT,
      });
      flooredIds.add(r.card_id);
    }
  }

  if (bandError) return fail(bandError);
  if (!computed) return fail('Could not solve a distribution for this target.');

  // A tier has "collapsed" when every one of its chase rows sits at the floor.
  // Reported only when 2+ tiers collapse, since that is when the ladder stops
  // conveying anything to the player.
  const collapsed = new Set<OddsRarity>();
  for (const rarity of RARITIES) {
    const tierRows = chase.filter((r) => r.rarity === rarity);
    if (tierRows.length > 0 && tierRows.every((r) => flooredIds.has(r.card_id))) {
      collapsed.add(rarity);
    }
  }

  return {
    error: null,
    computed,
    floored,
    tierCollapse: collapsed.size >= 2 ? RARITIES.filter((r) => collapsed.has(r)) : [],
    achievedRtp: rtpOf(computed, byId, packPrice),
  };
}
