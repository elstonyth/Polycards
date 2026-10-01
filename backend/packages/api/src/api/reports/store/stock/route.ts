import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { loadInventoryRows } from '../../../../modules/packs/inventory-view';
import { pageAll } from '../../../utils/page-all';

// GET /reports/store/stock?max=0: cards whose tracked stock on hand is at or
// below max (default 0: what the dashboard flags; below 0 = units owed to
// winners), lowest first, with the packs that can still draw them, plus the
// packs showing the sold-out badge. From loadInventoryRows, the admin
// inventory page's own rows, without the purchase cost. A card with no
// tracked inventory is never "low": it is left out.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.query.max ?? '0';
  if (typeof raw !== 'string' || !/^-?\d{1,4}$/.test(raw)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'max must be a whole number of units, like 0 or 2.',
    );
  }
  const max = Number(raw);
  const rows = (await loadInventoryRows(req.scope))
    .filter((r) => r.is_card && r.on_hand !== null && r.on_hand <= max)
    .sort((a, b) => a.on_hand! - b.on_hand! || a.name.localeCompare(b.name));
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const active = await packs.listPacks({ status: 'active' }, { take: 1000 });
  const activeSlugs = new Set(active.map((p) => p.slug));
  const handles = rows.map((r) => r.handle);
  const odds = handles.length
    ? await pageAll((opts) =>
        packs.listPackOdds(
          { card_id: handles },
          { ...opts, select: ['pack_id', 'card_id'] },
        ),
      )
    : [];
  const inPacks = new Map<string, Set<string>>();
  for (const o of odds) {
    if (!o.card_id || !activeSlugs.has(o.pack_id)) continue;
    inPacks.set(
      o.card_id,
      (inPacks.get(o.card_id) ?? new Set()).add(o.pack_id),
    );
  }
  res.json({
    currency: 'MYR',
    max,
    cards: rows.map((r) => ({
      card: r.name,
      handle: r.handle,
      on_hand: r.on_hand,
      in_vaults: r.in_vault,
      delivery_requested: r.requested,
      display_price: r.price,
      in_active_packs: [...(inPacks.get(r.handle) ?? [])].sort(),
    })),
    sold_out_badge_packs: active
      .filter((p) => !p.in_stock)
      .map((p) => ({ slug: p.slug, title: p.title })),
    note: 'on_hand below 0 means units owed to winners. A card at 0 can still be drawn; buyback covers the pull. Cards with untracked inventory are not listed. The sold-out badge is display only: those packs can still be opened. in_vaults and delivery_requested are separate counts, never to be added together.',
  });
}
