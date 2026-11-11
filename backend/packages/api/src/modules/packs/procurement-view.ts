import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import { loadInventoryRows, type InventoryRow } from './inventory-view';
import { stockAutoAllocationEnabled } from './stock-allocation-run';
import { HOLDING } from './stock-allocation';
import { displayMarketPrice, resolveFxRate } from './pricing';
import { toOptionalMoney } from './money';
import { isGraded, slabGrade, stockImage } from './card-view';
import { toProcure } from './stock-math';
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

type OpenOrder = { status: string; created_at: Date; handles: string[] };

// The purchasing department's list (spec 2026-10-28): every card with Qty to
// be procured >= 1, the card whose longest-waiting order is oldest first.
// `rows` are the Stock page rows for the open orders' cards. `newSince` = when
// today's 12am list was taken: an order placed after it and still `requested`
// can be canceled by the customer today, so it joins at the next 12am (owner
// 2026-10-28) and is left out of the demand here. Every other order counts —
// one moved to ready_to_ship by a Refresh holds shelf cards. Stock is never
// frozen: a GRN saved or edited during the day shows at once (user
// 2026-11-11: staff bought duplicate cards while waiting for 12am).
export function buildToBuyRows(
  orders: OpenOrder[],
  rows: InventoryRow[],
  newSince: Date | null,
): ToBuyRow[] {
  const oldest = new Map<string, Date>();
  const later = new Map<string, number>();
  for (const o of orders) {
    if (newSince && o.status === 'requested' && o.created_at >= newSince) {
      for (const h of o.handles) later.set(h, (later.get(h) ?? 0) + 1);
      continue;
    }
    if (HOLDING.has(o.status)) continue; // already holds its cards
    for (const h of o.handles) {
      const seen = oldest.get(h);
      if (!seen || o.created_at < seen) oldest.set(h, o.created_at);
    }
  }

  return rows
    .map((r) => {
      const requested = Math.max(0, r.requested - (later.get(r.handle) ?? 0));
      return {
        ...r,
        requested,
        to_procure: toProcure(r.on_hand, requested, r.ready_to_ship),
      };
    })
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

// buildToBuyRows over the open orders and stock right now.
export async function loadToBuyRows(
  container: MedusaContainer,
  newSince: Date | null = null,
): Promise<ToBuyRow[]> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  // Only a card some open order wants can be short, so the rows come from the
  // open orders, not the whole catalogue.
  const orders = await packs.openDeliveryOrdersForAllocation();
  const handles = [...new Set(orders.flatMap((o) => o.handles))];
  const rows = handles.length
    ? await loadInventoryRows(container, { handle: handles })
    : [];
  return buildToBuyRows(orders, rows, newSince);
}

// Records the 12am list — the job calls it right after the status run. The
// snapshot is the job's once-per-day guard and fixes WHICH orders are on the
// day's list (taken_at); the page reads stock live, not these rows.
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

// What the Procurement page shows. Orders join the list once a day at 12am,
// after the order statuses update (owner, 2026-10-28); stock is always live,
// so a GRN or invoice saved during the day takes its cards off at once (user,
// 2026-11-11). While STOCK_AUTO_ALLOCATION is on and tonight's run took its
// snapshot: orders as of that run (taken_at). While it is off nothing moves at
// 12am, and when no snapshot was taken since the last 12am (switch just turned
// on, or a missed night), every open order counts. taken_at null = no 12am
// cut. Note: the switch is read here by the server AND by the job on the
// worker, so it must be set on both (app-level env).
export async function currentToBuyList(
  container: MedusaContainer,
  now: Date = new Date(),
): Promise<{ rows: ToBuyListRow[]; taken_at: string | null }> {
  let takenAt: Date | null = null;
  if (stockAutoAllocationEnabled()) {
    const [snap] = await container
      .resolve<PacksModuleService>(PACKS_MODULE)
      .listProcurementSnapshots(
        { taken_at: { $gte: lastMidnightCutoff(now) } },
        { take: 1, order: { taken_at: 'DESC', id: 'DESC' } },
      );
    if (snap) takenAt = new Date(snap.taken_at);
  }
  return {
    rows: await withCardDetails(
      container,
      await loadToBuyRows(container, takenAt),
    ),
    taken_at: takenAt?.toISOString() ?? null,
  };
}
