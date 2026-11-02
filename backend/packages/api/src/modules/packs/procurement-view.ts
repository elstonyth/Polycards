import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import { loadInventoryRows, type InventoryRow } from './inventory-view';
import { stockAutoAllocationEnabled } from './stock-allocation-run';
import { displayMarketPrice, resolveFxRate } from './pricing';
import { toOptionalMoney } from './money';
import { isGraded, slabGrade, stockImage } from './card-view';
import { pageAll } from '../../api/utils/page-all';

export type ToBuyRow = Pick<
  InventoryRow,
  | 'handle'
  | 'name'
  | 'sku'
  | 'photo'
  | 'graded'
  | 'to_procure'
  | 'on_hand'
  | 'requested'
  | 'ready_to_ship'
  | 'fmv'
> & { oldest_order_at: string | null };

// What the page gets (owner 2026-10-29): staff screenshot the list into the
// buyers' group chat, so each row also carries the picture to look for and
// the PriceCharting price as is. image: graded = the baked slab composite
// (no tier frame), raw = the bare card. fmv_usd = PriceCharting's own number;
// fmv = that at the live rate in RM, with no 20% listing markup. set and grade
// ("PSA 10", null = raw) are what a buyer asks a seller for.
export type ToBuyListRow = ToBuyRow & {
  image: string | null;
  fmv_usd: number | null;
  set: string | null;
  grade: string | null;
};

type CardLook = {
  set: string;
  grader: string;
  grade: string;
  image: string;
  slab_image: string | null;
  market_value: unknown;
};

// Added when the list is served, not frozen into the 12am snapshot: the
// snapshot fixes WHAT to buy, while the picture and the price are read fresh
// — and lists frozen before this change get them too. GRADED/RAW is re-read
// from the card as well, so the label and the picture always agree. A row
// whose card row is gone keeps the product photo, its label and stored RM.
export function addCardDetails(
  rows: ToBuyRow[],
  cards: ReadonlyMap<string, CardLook>,
  fx: number,
): ToBuyListRow[] {
  return rows.map((r) => {
    const card = cards.get(r.handle);
    const usd = card ? toOptionalMoney(card.market_value) : null;
    const graded = card ? isGraded(card) : r.graded;
    return {
      ...r,
      graded,
      image: stockImage(graded, card, r.photo),
      set: card?.set || null,
      grade: card ? slabGrade(card) : null,
      fmv_usd: usd,
      fmv: usd === null ? r.fmv : displayMarketPrice(usd, fx, 1),
    };
  });
}

async function withCardDetails(
  container: MedusaContainer,
  rows: ToBuyRow[],
): Promise<ToBuyListRow[]> {
  if (!rows.length) return [];
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const handles = rows.map((r) => r.handle);
  // The picture and price are extras: a failed card read must not take the
  // purchasing list down with it, so the rows go out with the product photo
  // and stored RM instead.
  let cards: (CardLook & { handle: string })[] = [];
  try {
    cards = await pageAll((page) => packs.listCards({ handle: handles }, page));
  } catch (e) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[procurement] to-buy served without card details: ${e}`);
  }
  const fx = await resolveFxRate(packs);
  return addCardDetails(rows, new Map(cards.map((c) => [c.handle, c])), fx);
}

// The purchasing department's list (spec 2026-10-28): every card with Qty to
// be procured >= 1, the card whose longest-waiting order is oldest first.
// Live — computed from the open orders and stock right now.
export async function loadToBuyRows(
  container: MedusaContainer,
): Promise<ToBuyRow[]> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  // Only a card some open order wants can be short, so the rows come from the
  // open orders, not the whole catalogue.
  const orders = await packs.openDeliveryOrdersForAllocation();
  const oldest = new Map<string, Date>();
  for (const o of orders) {
    if (o.status === 'ready_to_ship') continue; // already holds its cards
    for (const h of o.handles) {
      const seen = oldest.get(h);
      if (!seen || o.created_at < seen) oldest.set(h, o.created_at);
    }
  }
  const handles = [...new Set(orders.flatMap((o) => o.handles))];
  const rows = handles.length
    ? await loadInventoryRows(container, { handle: handles })
    : [];

  return rows
    .filter((r) => r.to_procure >= 1)
    .map((r) => ({
      handle: r.handle,
      name: r.name,
      sku: r.sku,
      photo: r.photo,
      graded: r.graded,
      to_procure: r.to_procure,
      on_hand: r.on_hand,
      requested: r.requested,
      ready_to_ship: r.ready_to_ship,
      fmv: r.fmv,
      oldest_order_at: oldest.get(r.handle)?.toISOString() ?? null,
    }))
    .sort(
      (a, b) =>
        (a.oldest_order_at ?? '').localeCompare(b.oldest_order_at ?? '') ||
        a.name.localeCompare(b.name),
    );
}

// Freezes the live list — the 12am job calls it right after the status run.
export async function takeProcurementSnapshot(
  container: MedusaContainer,
  takenAt: Date = new Date(),
): Promise<number> {
  const rows = await loadToBuyRows(container);
  await container
    .resolve<PacksModuleService>(PACKS_MODULE)
    .createProcurementSnapshots({ taken_at: takenAt, to_buy: { rows } });
  return rows.length;
}

/** The most recent 12am Malaysia time (16:00 UTC, no DST) at or before now. */
export function lastMidnightCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCHours(16, 0, 0, 0);
  if (cutoff > now) cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  return cutoff;
}

// What the Procurement page shows (owner, 2026-10-28: the list updates once a
// day at 12am, after the order statuses do). While STOCK_AUTO_ALLOCATION is
// on: tonight's snapshot. While it is off nothing moves at 12am, so a frozen
// list would still hold `requested` orders the customer can cancel that day —
// the live list is served instead. Live too when no snapshot was taken since
// the last 12am (switch just turned on, or a missed night): an older list
// would hold orders canceled or shipped since. taken_at null = live.
// Note: the switch is read here by the server AND by the job on the worker,
// so it must be set on both (app-level env).
export async function currentToBuyList(
  container: MedusaContainer,
  now: Date = new Date(),
): Promise<{ rows: ToBuyListRow[]; taken_at: string | null }> {
  if (stockAutoAllocationEnabled()) {
    const [snap] = await container
      .resolve<PacksModuleService>(PACKS_MODULE)
      .listProcurementSnapshots(
        { taken_at: { $gte: lastMidnightCutoff(now) } },
        { take: 1, order: { taken_at: 'DESC', id: 'DESC' } },
      );
    if (snap) {
      return {
        rows: await withCardDetails(
          container,
          (snap.to_buy as { rows: ToBuyRow[] }).rows,
        ),
        taken_at: new Date(snap.taken_at).toISOString(),
      };
    }
  }
  return {
    rows: await withCardDetails(container, await loadToBuyRows(container)),
    taken_at: null,
  };
}
