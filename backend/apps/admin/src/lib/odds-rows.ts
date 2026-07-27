import type { OddsRow } from './packs-api';
import { computeSetWeights, type SetEntry } from '@acme/odds-math';

// One editable row in the pack odds editor: the immutable card facts + its
// current saved %, plus the editable PER-PACK rarity (drives the balancer
// share), the lock state, and the win-rate inputs as strings so the operator
// can type freely (e.g. "12.").
export type EditRow = {
  card_id: string;
  name: string;
  image: string;
  /** Baked graded-slab composite (null for raw cards) — thumbnail prefers it. */
  slab_image: string | null;
  rarity: string;
  /** DISPLAY PRICE (FMV × fx × the card's markup), not raw FMV — §2.4. The
   *  EV/RTP readouts are computed on the same number the storefront quotes. */
  market_value: number;
  stock: number | null;
  currentPct: number;
  locked: boolean;
  pctInput: string;
  /** Set-2/3 win-rate overrides. '' = INHERIT the previous set for this card
   *  (3 → 2 → 1); '0' is a real 0% override and must never collapse to ''. */
  pctInput2: string;
  pctInput3: string;
  /** Admin-picked Top Hit display order as a free-typed string ('' = not a
   *  Top Hit; '1' renders leftmost on the pack page). Saved on blur/Enter. */
  topHitInput: string;
  /** Staged from the cards list's bulk "Add to gacha pack" — NOT a pool member
   *  yet. The editor's save persists the membership first, then the odds. */
  pending?: boolean;
};

// Map a server odds snapshot into the editable row buffer. Used to seed the
// editor on load and to reseed after a membership change. The set-2/3 inputs
// seed from the RAW nullable weight columns (not the resolved pct_2/pct_3), so
// "overridden" stays distinguishable from "inherited" across a reload.
export const mapOddsToRows = (odds: OddsRow[]): EditRow[] =>
  odds.map((o) => ({
    card_id: o.card_id,
    name: o.name,
    image: o.image,
    slab_image: o.slab_image,
    rarity: o.rarity,
    market_value: o.market_value,
    stock: o.stock,
    currentPct: o.pct,
    locked: o.locked,
    pctInput: String(o.pct),
    pctInput2: o.weight_2 == null ? '' : String(o.weight_2 / 100),
    pctInput3: o.weight_3 == null ? '' : String(o.weight_3 / 100),
    topHitInput: o.top_hit_order == null ? '' : String(o.top_hit_order),
  }));

// Map the editable rows back into the odds-math entry shape — the SAME mapping
// the live preview and the save handler use, so what the operator previews is
// exactly what gets persisted.
//
// '' → null is the load-bearing rule: `null` means "inherit the previous set",
// while `Number('')` would be 0 — an explicit 0% that materializes weight_N = 0
// and rewrites a whole alternate odds table. pct_2/pct_3 are also STRICTLY
// typed server-side (number | null), so the string must be parsed here; a raw
// '40' comes back a 400.
export const rowsToSetEntries = (rows: EditRow[]): SetEntry[] =>
  rows.map((r) => ({
    card_id: r.card_id,
    locked: r.locked,
    pct: Number(r.pctInput),
    rarity: r.rarity,
    pct_2: r.pctInput2 === '' ? null : Number(r.pctInput2),
    pct_3: r.pctInput3 === '' ? null : Number(r.pctInput3),
  }));

export type SetsPreview = {
  /** Non-null ⇒ do NOT save. Sets 2/3 come back prefixed 'Set N: '. */
  error: string | null;
  /** Effective win % per set, per card. EMPTY when `error` is set. */
  pct: Record<1 | 2 | 3, Map<string, number>>;
};

/**
 * Live preview of all three odds tables. A thin wrapper over the EXACT function
 * the save step runs (`computeSetWeights`), so the preview cannot drift from
 * what gets persisted — the only work here is resolving the sparse storage rows
 * (null weight_N = inherit) back into an effective % per set.
 *
 * On error `computeSetWeights` returns no rows, so the maps come back empty and
 * every readout renders '—'. That is deliberate: a best-effort 0% would read as
 * "this card is unpullable" when nothing is being saved at all.
 */
export const previewSets = (rows: EditRow[]): SetsPreview => {
  const { error, rows: computed } = computeSetWeights(rowsToSetEntries(rows));
  const pct: SetsPreview['pct'] = { 1: new Map(), 2: new Map(), 3: new Map() };
  for (const r of computed) {
    const w2 = r.weight_2 ?? r.weight;
    pct[1].set(r.card_id, r.weight / 100);
    pct[2].set(r.card_id, w2 / 100);
    pct[3].set(r.card_id, (r.weight_3 ?? w2) / 100);
  }
  return { error, pct };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Theoretical EV (RM) and RTP (%) for one odds set. CLIENT MIRROR of
 * packTheoreticalRtp in backend/packages/api/src/modules/packs/economy.ts —
 * same integer-cent fold and the same "RTP off the UNROUNDED EV" rule, so the
 * live chips here agree with the server's numbers on the packs list one click
 * away. Null (→ '—') for an empty pool, an unpriced pack, or an errored preview.
 */
export const setEvRtp = (
  rows: EditRow[],
  pct: Map<string, number>,
  price: number,
): { ev: number; rtp: number } | null => {
  if (rows.length === 0 || pct.size === 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const cents = rows.reduce((sum, r) => {
    const p = pct.get(r.card_id);
    if (p === undefined || !Number.isFinite(r.market_value)) return sum;
    return sum + Math.round(r.market_value * 100) * (p / 100);
  }, 0);
  return {
    ev: Math.round(cents) / 100,
    rtp: round2((cents / 100 / price) * 100),
  };
};

/**
 * Published EV (RM): Σ over the filled-in tiers of (average card price in that
 * tier) × (published % / 100). CLIENT MIRROR of publishedEv in the same backend
 * module, run against the tier inputs the operator is CURRENTLY typing (the
 * packs list shows the saved server-side figure). Tiers with no card in the pool
 * are skipped; null when nothing contributes.
 */
export const publishedEvPreview = (
  rows: EditRow[],
  tiers: Record<string, string>,
): number | null => {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const t = sums.get(r.rarity) ?? { sum: 0, n: 0 };
    t.sum += r.market_value;
    t.n += 1;
    sums.set(r.rarity, t);
  }
  let cents = 0;
  let any = false;
  for (const [tier, raw] of Object.entries(tiers)) {
    const t = sums.get(tier);
    const pct = raw.trim() === '' ? NaN : Number(raw);
    if (!t || !Number.isFinite(pct)) continue;
    const avg = t.sum / t.n;
    if (!Number.isFinite(avg)) continue;
    any = true;
    cents += Math.round(avg * 100) * (pct / 100);
  }
  return any ? Math.round(cents) / 100 : null;
};

import {
  type RarityProposal,
  type RtpSolveResult,
  type RtpSolveRow,
} from '@acme/odds-math';

// A free-typed rate input ('' while the operator is mid-edit, '12.' etc.)
// must never reach the solver as NaN — it would poison every downstream sum.
// UNLOCKED ONLY: the solver recomputes these rows and never reads this pct
// (see rowsToSolveInput below), so a mid-typing '' or '12.' must not error.
const numOr0 = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

// LOCKED rows are the opposite: a blank or malformed rate must reach the
// solver AS NaN so solveOddsForRtp's own range guard rejects it, instead of
// silently pinning the card at 0% (a normal save would have refused this
// same input). `Number('')` is 0, not NaN, so blank needs an explicit check.
const numOrNaN = (s: string): number => (s.trim() === '' ? NaN : Number(s));

/** Editor rows -> solver input. `value` is the DISPLAY price, matching the
 *  Value column and the EV/RTP tiles.
 *
 *  WARNING (set-1 only): this ALWAYS reads set-1's `pctInput` for locked
 *  rows, regardless of which set the solve targets — there is no pctInput2/
 *  pctInput3 equivalent here. Solving for set 2/3 would compute the chase
 *  budget off the wrong pinned rate, which is why the editor's `autoSplit`
 *  handler (routes/packs/[slug]/page.tsx) only ever calls this for set 1.
 *  See the matching warning on `applySolveResult` below. */
export const rowsToSolveInput = (rows: EditRow[]): RtpSolveRow[] =>
  rows.map((r) => ({
    card_id: r.card_id,
    locked: r.locked,
    rarity: r.rarity,
    value: r.market_value,
    pct: r.locked ? numOrNaN(r.pctInput) : numOr0(r.pctInput),
  }));

/** True when any row carries a non-empty Set 2/3 input — i.e. that set is
 *  MATERIALIZED for at least one card, not purely inherited (3 → 2 → 1).
 *  True whether the operator actually typed an override OR the value merely
 *  reflects a stored balancer share: mapOddsToRows seeds pctInput2/3 straight
 *  from the raw weight_2/weight_3 columns, and computeSetWeights materializes
 *  weight_s for every unlocked Common balancer too, not only for explicit
 *  overrides — so the two are indistinguishable once loaded into the editor.
 *
 *  Callers must check this before auto-splitting: auto-split rewrites
 *  `rarity` (applyRarityProposals below), a single column shared by all
 *  three sets. If a card that WAS an unlocked Common balancer in set 2/3
 *  gets retiered away from Common, computeSetWeights's set-2/3 recompute
 *  stops treating it as a balancer and PINS it at whatever pctInput2/3
 *  already held — silently, since balanceOdds only errors when pinned mass
 *  exceeds 100%. */
export const hasMaterializedSetOverrides = (rows: EditRow[]): boolean =>
  rows.some((r) => r.pctInput2 !== '' || r.pctInput3 !== '');

/** Stage proposed tiers as unsaved edits. Returns a new array; rows without a
 *  proposal are untouched. */
export const applyRarityProposals = (
  rows: EditRow[],
  proposals: RarityProposal[],
): EditRow[] => {
  const byId = new Map(proposals.map((p) => [p.card_id, p.rarity]));
  return rows.map((r) => {
    const rarity = byId.get(r.card_id);
    return rarity ? { ...r, rarity } : { ...r };
  });
};

/** Stage solved rates into the targeted set's input. A failed solve applies
 *  nothing — the caller surfaces `result.error`.
 *
 *  WARNING (set-1 only in practice): `result` must come from
 *  `solveOddsForRtp(rowsToSolveInput(rows), ...)`, which always pins LOCKED
 *  rows at set-1's `pctInput` no matter which `set` is passed here. The unit
 *  tests below exercise `set: 2` as a pure mapping check (stage into
 *  pctInput2, leave everything else alone) — that is NOT sanctioning an
 *  end-to-end auto-split of set 2/3. The editor's UI only ever calls this
 *  with `set: 1` (see the `autoSplit` handler in routes/packs/[slug]/page.tsx,
 *  which also guards against corrupting an already-materialized set 2/3 —
 *  see `hasMaterializedSetOverrides` above). */
export const applySolveResult = (
  rows: EditRow[],
  result: RtpSolveResult,
  set: 1 | 2 | 3,
): EditRow[] => {
  if (result.error) return rows;
  const byId = new Map(result.computed.map((c) => [c.card_id, c.pct]));
  return rows.map((r) => {
    const pct = byId.get(r.card_id);
    if (pct === undefined) return { ...r };
    // Trim float noise; the editor stores rates as free-typed strings.
    const text = String(Math.round(pct * 1e6) / 1e6);
    if (set === 1) return { ...r, pctInput: text };
    if (set === 2) return { ...r, pctInput2: text };
    return { ...r, pctInput3: text };
  });
};
