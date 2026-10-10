import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { loadInventoryRows } from '../../../../modules/packs/inventory-view';
import { pageAll } from '../../../utils/page-all';

// GET /reports/store/stock?max=0&limit=50: cards whose tracked stock on hand
// is at or below max (default 0: what the dashboard flags; below 0 = units
// owed to winners), counted in full, then the lowest `limit` of them with the
// packs that can still draw them, plus the packs showing the sold-out badge.
// The list is capped because live stock has hundreds of cards at 0, far more
// than a desk bot can read (its tool results spill to disk above 50K chars).
// From loadInventoryRows, the admin inventory page's own rows, without the
// purchase cost. A card with no tracked inventory is never "low": it is left
// out.
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
  const rawLimit = req.query.limit ?? '50';
  if (
    typeof rawLimit !== 'string' ||
    !/^\d{1,3}$/.test(rawLimit) ||
    Number(rawLimit) < 1 ||
    Number(rawLimit) > 200
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'limit must be a whole number from 1 to 200.',
    );
  }
  const max = Number(raw);
  const rows = (await loadInventoryRows(req.scope))
    .filter((r) => r.is_card && r.on_hand !== null && r.on_hand <= max)
    .sort((a, b) => a.on_hand! - b.on_hand! || a.name.localeCompare(b.name));
  const shown = rows.slice(0, Number(rawLimit));
  const owed = rows.filter((r) => r.on_hand! < 0);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const active = await packs.listPacks({ status: 'active' }, { take: 1000 });
  const activeSlugs = new Set(active.map((p) => p.slug));
  const handles = shown.map((r) => r.handle);
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
    matching_cards: rows.length,
    owed: {
      cards: owed.length,
      units: owed.reduce((sum, r) => sum - r.on_hand!, 0),
    },
    cards_not_shown: rows.length - shown.length,
    cards: shown.map((r) => ({
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
    note: 'matching_cards and owed count every card at or below max; cards lists only the lowest ones (cards_not_shown are left out), so give the counts, not the length of the list. on_hand below 0 means units owed to winners. A card at 0 can still be drawn; buyback covers the pull. Cards with untracked inventory are not listed. Sold-out packs stay listed but paid opens are refused; vault gifts and free rips already given still open. in_vaults and delivery_requested are separate counts, never to be added together.',
  });
}
