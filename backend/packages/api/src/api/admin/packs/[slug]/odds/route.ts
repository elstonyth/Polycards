import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { savePackOddsWorkflow } from '../../../../../workflows/save-pack-odds';
import { RARITIES, type SetEntry } from '@acme/odds-math';
import { getCardStockByHandle } from '../../../../../modules/packs/card-stock';
import { toMoney } from '../../../../../modules/packs/money';
import {
  resolveFxRate,
  displayMarketPrice,
  DEFAULT_MARKET_MULTIPLIER,
} from '../../../../../modules/packs/pricing';
import {
  weightForSet,
  type OddsSet,
} from '../../../../../modules/packs/odds-sets';
import { cardByHandle } from '../../../../../modules/packs/card-view';
import { clearPackDetailCache } from '../../../../store/packs/[slug]/route';
import { pageAll } from '../../../../utils/page-all';

const round2 = (n: number): number => Math.round(n * 100) / 100;

// One per-card row for the editor form: card display fields + the row's CURRENT
// per-pack rarity, win % and lock state — for ALL THREE odds sets (§2.4).
// `pct`/`pct_2`/`pct_3` are weight / Σweight × 100 (NOT weight/100): the seed
// ships rarity-relative weights that are only normalized to basis points on the
// first save, so deriving from the running total reads correctly in BOTH states
// (pre- and post-normalization). Each set divides by its OWN total, and both
// sides of that ratio go through `weightForSet` — sets 2/3 are stored sparsely
// (NULL = inherit 3→2→1), so a card that never overrode set 2 still contributes
// its set-1 weight to set 2's denominator. `weight_2`/`weight_3` are the RAW
// nullable columns, so the editor can tell "overridden" from "inherited".
// `rarity` comes from the PackOdds row — it is this pack's tier for the card,
// not a card property.
type OddsRow = {
  card_id: string;
  name: string;
  image: string;
  slab_image: string | null;
  rarity: string;
  /** DISPLAY PRICE (FMV × fx × per-card multiplier), not raw FMV — §2.4. */
  market_value: number;
  // Available physical units (null = untracked/infinite). Display-only —
  // nothing is excluded at any count; wins keep decrementing below 0, so a
  // negative value = units owed to winners.
  stock: number | null;
  weight: number;
  /** Raw set-2/3 basis points; null = inherit the previous set for this card. */
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
  pct: number;
  pct_2: number;
  pct_3: number;
  /** Admin-picked Top Hit display order (1-based; null = not a Top Hit). */
  top_hit_order: number | null;
};

// Read-only pack composition (§2.4.8) — derived from the pool, never stored.
type PackGroup = 'RAW' | 'GRADED' | 'MIX' | null;

// ponytail: Task 8 exports a shared `isGraded`; swap this one-liner for it then.
const isGraded = (c: { grader?: string | null }): boolean =>
  (c.grader ?? '').trim() !== '';

// GET /admin/packs/:slug/odds — load the editor state (admin-only, auto-protected).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packsModuleService: PacksModuleService =
    req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  const [pack] = await packsModuleService.listPacks({ slug }, { take: 1 });
  if (!pack) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  // PAGED — the editor must list EVERY card row so an operator can see and tune
  // a pack with 2000+ members; a take:1000 cap would hide (and risk dropping on
  // save) every card past the 1000th.
  const allOdds = await pageAll((opts) =>
    packsModuleService.listPackOdds({ pack_id: slug }, opts),
  );
  // This route renders the card-odds form — reward rows (card_id null) have no
  // Card and must stay invisible here. Narrows card_id to string.
  const odds = allOdds.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );

  const handles = odds.map((o) => o.card_id);
  const cards = handles.length
    ? await packsModuleService.listCards(
        { handle: handles },
        { take: handles.length },
      )
    : [];
  const byHandle = cardByHandle(cards);
  const stockByHandle = await getCardStockByHandle(req.scope, handles);
  // FMV is stored in USD; the Value column shows the MYR PRICE the customer
  // sees — FMV × live fx × the card's own markup multiplier — so the editor's
  // RTP readout is computed on the same numbers the storefront quotes
  // (POLYCARD-BACK §2.4; matches `displayPrice` in admin-card.ts).
  const fx = await resolveFxRate(packsModuleService);

  // Each set is normalized against its OWN resolved total (inherited weights
  // included) — a set-2 override changes set 2's denominator, not set 1's.
  const totalFor = (s: OddsSet): number =>
    odds.reduce((sum, o) => sum + weightForSet(o, s), 0) || 1;
  const totals: Record<OddsSet, number> = {
    1: totalFor(1),
    2: totalFor(2),
    3: totalFor(3),
  };

  const rows: OddsRow[] = [];
  for (const o of odds) {
    const card = byHandle.get(o.card_id);
    if (!card) continue; // drop odds whose card is missing
    rows.push({
      card_id: card.handle,
      name: card.name,
      image: card.image,
      slab_image: card.slab_image ?? null,
      rarity: o.rarity ?? 'Common',
      market_value: displayMarketPrice(
        toMoney(card.market_value),
        fx,
        toMoney(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      ),
      stock: stockByHandle.get(card.handle) ?? null,
      weight: o.weight,
      weight_2: o.weight_2 ?? null,
      weight_3: o.weight_3 ?? null,
      locked: o.locked,
      pct: round2((weightForSet(o, 1) / totals[1]) * 100),
      pct_2: round2((weightForSet(o, 2) / totals[2]) * 100),
      pct_3: round2((weightForSet(o, 3) / totals[3]) * 100),
      top_hit_order: o.top_hit_order ?? null,
    });
  }
  // Rarest-by-value first so the high-value cards sit at the top of the form.
  rows.sort((a, b) => b.market_value - a.market_value);

  // §2.4.8 — composition is AUTO-DETECTED from the pool, never operator-set.
  const graded = cards.filter(isGraded).length;
  const group: PackGroup = !cards.length
    ? null
    : graded === cards.length
      ? 'GRADED'
      : graded === 0
        ? 'RAW'
        : 'MIX';

  res.json({
    pack: {
      slug: pack.slug,
      title: pack.title,
      category: pack.category,
      status: pack.status,
      // The editor's live RTP readout is Σ(pct × price) / price.
      price: toMoney(pack.price),
      group,
    },
    odds: rows,
  });
}

type SaveBody = { entries?: unknown };

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// A set-2/3 override is STRICT (`number | null`) where set-1 `pct` is lenient:
// the per-set columns are new, so nothing legacy sends strings for them, and a
// silently-coerced garbage value here would rewrite a whole alternate odds
// table. An ABSENT key becomes an EXPLICIT null — computeSetWeights reads
// `!== null` as "the operator set this", so an `undefined` slipping through
// would materialize weight_2/weight_3 on every card of every save.
const setPct = (
  e: Record<string, unknown>,
  key: 'pct_2' | 'pct_3',
): number | null => {
  const v = e[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad(`Each entry's '${key}' must be a number or null.`);
  }
  return v as number;
};

/**
 * Coerce the POST body's `entries` to the workflow input shape, rejecting
 * malformed rows up front. Throws INVALID_DATA (→ 400) rather than returning,
 * so the rules are unit-testable without a request/response pair.
 */
export function coerceOddsEntries(raw: unknown): SetEntry[] {
  if (!Array.isArray(raw)) bad('Body must include an `entries` array.');
  const entries: SetEntry[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') bad('Each entry must be an object.');
    const e = item as Record<string, unknown>;
    if (typeof e.card_id !== 'string' || typeof e.locked !== 'boolean') {
      bad('Each entry needs a string card_id and boolean locked.');
    }
    if (
      typeof e.rarity !== 'string' ||
      !(RARITIES as readonly string[]).includes(e.rarity)
    ) {
      bad(`Each entry needs a rarity (one of: ${RARITIES.join(', ')}).`);
    }
    entries.push({
      card_id: e.card_id as string,
      locked: e.locked as boolean,
      pct: Number(e.pct ?? 0),
      rarity: e.rarity as string,
      pct_2: setPct(e, 'pct_2'),
      pct_3: setPct(e, 'pct_3'),
    });
  }
  return entries;
}

// POST /admin/packs/:slug/odds — persist new win rates via the compensated
// even-split workflow. Domain validation (Σlocked ≤ 100, all-locked ⇒ Σ == 100,
// card-set match) lives in the workflow; here we only coerce the body shape.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { slug } = req.params;
  const body = (req.body ?? {}) as SaveBody;
  const entries = coerceOddsEntries(body.entries);

  const { result } = await savePackOddsWorkflow(req.scope).run({
    input: { pack_id: slug, entries },
  });

  // A per-card rarity change is shown on the storefront detail (Top Hits +
  // the reel's rarity lighting), so bust the 30s detail cache to reflect it now.
  clearPackDetailCache();

  res.json({ odds: result });
}
