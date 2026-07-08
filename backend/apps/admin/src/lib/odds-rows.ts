import type { OddsRow } from './packs-api';
import type { OddsInput } from '@acme/odds-math';

// One editable row in the pack odds editor: the immutable card facts + its
// current saved %, plus the editable PER-PACK rarity (drives the unlocked
// share), the lock state, and (when locked) the win-rate input as a string so
// the operator can type freely (e.g. "12.").
export type EditRow = {
  card_id: string;
  name: string;
  image: string;
  /** Baked graded-slab composite (null for raw cards) — thumbnail prefers it. */
  slab_image: string | null;
  rarity: string;
  market_value: number;
  stock: number | null;
  currentPct: number;
  locked: boolean;
  pctInput: string;
  /** Admin-picked Top Hit display order as a free-typed string ('' = not a
   *  Top Hit; '1' renders leftmost on the pack page). Saved on blur/Enter. */
  topHitInput: string;
};

// Map a server odds snapshot into the editable row buffer. Used to seed the
// editor on load and to reseed after a membership change.
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
    topHitInput: o.top_hit_order == null ? '' : String(o.top_hit_order),
  }));

// Map the editable rows back into the odds-math input shape — the SAME mapping
// the live preview and the save handler use, so what the operator previews is
// exactly what gets persisted.
export const rowsToOddsInputs = (rows: EditRow[]): OddsInput[] =>
  rows.map((r) => ({
    card_id: r.card_id,
    locked: r.locked,
    pct: Number(r.pctInput),
    rarity: r.rarity,
  }));
