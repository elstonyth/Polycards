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
import { cardByHandle, isGraded } from '../../../../../modules/packs/card-view';
import { normalizeTierRanges } from '../../../../../modules/packs/tier-settings-validate';
import { clearPackDetailCache } from '../../../../store/packs/[slug]/route';
import { clearAdminPackListCache } from '../../route';
import { pageAll } from '../../../../utils/page-all';

// 4-decimal odds: the editor seeds its inputs from these pcts, so anything
// coarser than the storage grain (0.0001%) would lose precision on load→save.
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

// One per-card row for the editor form: card display fields + the row's CURRENT
// per-pack rarity, win % and lock state — for ALL THREE odds sets (§2.4).
// `pct`/`pct_2`/`pct_3` are weight / Σweight × 100 (NOT weight/100): the seed
// ships rarity-relative weights that are only normalized to integer units on the
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
  /** Raw set-2/3 integer units; null = inherit the previous set for this card. */
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
      pct: round4((weightForSet(o, 1) / totals[1]) * 100),
      pct_2: round4((weightForSet(o, 2) / totals[2]) * 100),
      pct_3: round4((weightForSet(o, 3) / totals[3]) * 100),
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
      target_rtp_bps: pack.target_rtp_bps ?? 7000,
      group,
      // Per-pack tier price-range override; null = inherit the global
      // tier_settings singleton. Null vs {} matters: a stored (even empty)
      // map replaces the global ladder wholesale for this pack.
      tier_ranges:
        pack.tier_ranges == null
          ? null
          : normalizeTierRanges(pack.tier_ranges),
    },
    odds: rows,
  });
}

type SaveBody = { entries?: unknown };

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// Set 1's pct is required-with-default: absent/null means 0, but a present
// non-finite value ('abc', {}) must 400 — Number() would silently coerce it
// to NaN and balanceOdds clamps NaN to 0%. Numeric strings stay accepted
// (documented set-1 lenience; the editor itself always sends numbers).
const basePct = (e: Record<string, unknown>): number => {
  const v = e.pct;
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    bad(`Each entry needs a finite numeric pct (got ${typeof v}).`);
  }
  return n;
};

// A set-2/3 override is STRICT (`number | null`) where set-1 `pct` defaults to 0:
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

// Optional on every odds save: ABSENT means "leave the stored target alone".
// Bounds are wide (0.01% - 10000%) because a target above 100% is a legitimate
// loss-leader promo; only nonsense is rejected.
export function coerceTargetRtpBps(raw: unknown): number | undefined {
  const v = (raw as Record<string, unknown>)?.target_rtp_bps;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1_000_000) {
    bad(`'target_rtp_bps' must be an integer between 1 and 1000000.`);
  }
  return v as number;
}

/**
 * Coerce the POST body's `entries` to the workflow input shape, rejecting
 * malformed rows up front. Throws INVALID_DATA (→ 400) rather than returning,
 * so the rules are unit-testable without a request/response pair.
 */
export function coerceOddsEntries(raw: unknown): SetEntry[] {
  if (!Array.isArray(raw)) bad('Body must include an `entries` array.');
  const entries: SetEntry[] = [];
  // A card_id may appear at most ONCE. The workflow's pool check compares Set
  // sizes on both sides, so a duplicate slips past it and then collides in
  // `idByCard`/`rarityByCard` — the pack persists a Σweight ≠ TOTAL_UNITS that the
  // operator never typed. Cheapest closure is here, at the body boundary.
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') bad('Each entry must be an object.');
    const e = item as Record<string, unknown>;
    if (typeof e.card_id !== 'string' || typeof e.locked !== 'boolean') {
      bad('Each entry needs a string card_id and boolean locked.');
    }
    if (seen.has(e.card_id as string)) {
      bad(
        `Duplicate card_id '${e.card_id as string}' — each card may appear only once.`,
      );
    }
    seen.add(e.card_id as string);
    if (
      typeof e.rarity !== 'string' ||
      !(RARITIES as readonly string[]).includes(e.rarity)
    ) {
      bad(`Each entry needs a rarity (one of: ${RARITIES.join(', ')}).`);
    }
    entries.push({
      card_id: e.card_id as string,
      locked: e.locked as boolean,
      pct: basePct(e),
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
  // Coerced/validated BEFORE the workflow runs, so a bad target 400s without
  // writing any odds (see coerceTargetRtpBps above `bad`'s throw).
  const targetRtpBps = coerceTargetRtpBps(req.body ?? {});

  const { result } = await savePackOddsWorkflow(req.scope).run({
    input: { pack_id: slug, entries },
  });

  if (targetRtpBps !== undefined) {
    const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
    const [pack] = await packs.listPacks({ slug }, { take: 1 });
    if (pack) {
      await packs.updatePacks([{ id: pack.id, target_rtp_bps: targetRtpBps }]);
    }
  }

  // A per-card rarity change is shown on the storefront detail (Top Hits +
  // the reel's rarity lighting), so bust the 30s detail cache to reflect it now.
  clearPackDetailCache();
  // The weights (and rarity, via the tier price averages) ARE the admin list's
  // EV/RTP inputs — without this the operator saves odds here, returns to the
  // list they came from, and reads their pre-edit numbers for up to 30s.
  clearAdminPackListCache();

  res.json({ odds: result });
}
