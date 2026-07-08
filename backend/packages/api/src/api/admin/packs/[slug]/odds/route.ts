import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { savePackOddsWorkflow } from '../../../../../workflows/save-pack-odds';
import { RARITIES, type OddsInput } from '@acme/odds-math';
import { getCardStockByHandle } from '../../../../../modules/packs/card-stock';
import { toMoney } from '../../../../../modules/packs/money';
import {
  resolveFxRate,
  displayMarketPrice,
} from '../../../../../modules/packs/pricing';
import { cardByHandle } from '../../../../../modules/packs/card-view';

const round2 = (n: number): number => Math.round(n * 100) / 100;

// One per-card row for the editor form: card display fields + the row's CURRENT
// per-pack rarity, win % and lock state. `pct` is weight / Σweight × 100 (NOT
// weight/100): the seed ships rarity-relative weights that are only normalized
// to basis points on the first save, so deriving from the running total reads
// correctly in BOTH states (pre- and post-normalization). `rarity` comes from
// the PackOdds row — it is this pack's tier for the card, not a card property.
type OddsRow = {
  card_id: string;
  name: string;
  image: string;
  slab_image: string | null;
  rarity: string;
  market_value: number;
  // Available physical units (null = untracked/infinite). Display-only —
  // nothing is excluded at any count; wins keep decrementing below 0, so a
  // negative value = units owed to winners.
  stock: number | null;
  weight: number;
  locked: boolean;
  pct: number;
  /** Admin-picked Top Hit display order (1-based; null = not a Top Hit). */
  top_hit_order: number | null;
};

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

  const allOdds = await packsModuleService.listPackOdds(
    { pack_id: slug },
    { take: 1000 },
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
  // FMV stored USD; the odds editor shows MYR at the live rate (no markup).
  const fx = await resolveFxRate(packsModuleService);

  const total = odds.reduce((sum, o) => sum + o.weight, 0) || 1;

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
      market_value: displayMarketPrice(toMoney(card.market_value), fx, 1),
      stock: stockByHandle.get(card.handle) ?? null,
      weight: o.weight,
      locked: o.locked,
      pct: round2((o.weight / total) * 100),
      top_hit_order: o.top_hit_order ?? null,
    });
  }
  // Rarest-by-value first so the high-value cards sit at the top of the form.
  rows.sort((a, b) => b.market_value - a.market_value);

  res.json({
    pack: {
      slug: pack.slug,
      title: pack.title,
      category: pack.category,
      status: pack.status,
    },
    odds: rows,
  });
}

type SaveBody = { entries?: unknown };

// POST /admin/packs/:slug/odds — persist new win rates via the compensated
// even-split workflow. Domain validation (Σlocked ≤ 100, all-locked ⇒ Σ == 100,
// card-set match) lives in the workflow; here we only coerce the body shape.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { slug } = req.params;
  const body = (req.body ?? {}) as SaveBody;

  if (!Array.isArray(body.entries)) {
    res.status(400).json({ message: 'Body must include an `entries` array.' });
    return;
  }

  // Coerce to the workflow input shape; reject malformed rows up front.
  const entries: OddsInput[] = [];
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object') {
      res.status(400).json({ message: 'Each entry must be an object.' });
      return;
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.card_id !== 'string' || typeof e.locked !== 'boolean') {
      res.status(400).json({
        message: 'Each entry needs a string card_id and boolean locked.',
      });
      return;
    }
    if (
      typeof e.rarity !== 'string' ||
      !(RARITIES as readonly string[]).includes(e.rarity)
    ) {
      res.status(400).json({
        message: `Each entry needs a rarity (one of: ${RARITIES.join(', ')}).`,
      });
      return;
    }
    entries.push({
      card_id: e.card_id,
      locked: e.locked,
      pct: Number(e.pct ?? 0),
      rarity: e.rarity,
    });
  }

  const { result } = await savePackOddsWorkflow(req.scope).run({
    input: { pack_id: slug, entries },
  });

  res.json({ odds: result });
}
