import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import {
  validateDeliveryStatusTransition,
  type DeliveryStatus,
} from './delivery';
import { serializeDeliveryOrders } from './delivery-view';
import { lastMidnightCutoff } from './procurement-view';
import { pageAll } from '../../api/utils/page-all';
import {
  cellText,
  textCell,
  type Cell,
  type Grid,
} from '../../utils/google-sheets';

// The "All orders" tab of the live procurement sheet (owner 2026-11-25): every
// delivery order with its shipping status, and staff can move an order by
// changing STATUS (or TRACKING) in the sheet. Those edits run the same
// updateDeliveryOrderWorkflow as the admin buttons, with the same transition
// rules and customer notices, audited as system:google-sheet.
//
// The sheet has no staff login, two-step code or role behind it, and everyone
// who marks the To buy tab is an Editor of it, so it does only the shipping
// desk's moves (SHEET_MOVES): Ready to ship <-> Pending to ship, and either to
// Shipped with a tracking number. Everything else stays in the admin: the 12am
// run's and stock allocation's moves, cancelling (cards back to the vault),
// stepping back out of the ship pile (the "parcel pulled" check, incident
// 2026-11-03) and Completed (final; the shipment tracker does it). Tracking is
// set only before shipping and never cleared from the sheet (code review
// 2026-11-25).
//
// Hidden SYNCED STATUS / SYNCED TRACKING hold what the sync last wrote, and
// SYNCED ORDER the order they belong to, so a row sorted away from its hidden
// cells is ignored instead of acting for another order. A cell that differs
// from them was edited in the sheet; if the order itself moved since (admin,
// 12am run, customer cancel), the admin side wins.

export const ORDER_HEADERS = [
  'ORDER',
  'PLACED',
  'NAME',
  'CARDS',
  'QTY',
  'STATUS',
  'TRACKING',
  'NOTE',
  'SHIPPED',
  'SYNCED STATUS',
  'SYNCED TRACKING',
  'SYNCED ORDER',
];
export const ORDER_COL = {
  ORDER: 0,
  CARDS: 3,
  STATUS: 5,
  TRACKING: 6,
  NOTE: 7,
  SYNC_STATUS: 9,
  SYNC_TRACKING: 10,
  SYNC_ORDER: 11,
} as const;

/** The admin's own words for each status (admin lib/format.ts). */
export const STATUS_WORD: Record<DeliveryStatus, string> = {
  requested: 'Requested',
  processed: 'Processed',
  ready_to_ship: 'Ready to ship',
  pending_ship: 'Pending to ship',
  shipped: 'Shipped',
  completed: 'Completed',
  canceled: 'Canceled',
};
// Pre-rename tokens a legacy row may still hold (delivery.ts ALLOWED overlay).
const LEGACY_WORD: Record<string, string> = {
  packing: 'Processed',
  delivered: 'Completed',
};
const word = (status: string): string =>
  STATUS_WORD[status as DeliveryStatus] ?? LEGACY_WORD[status] ?? status;
const norm = (s: string): string => s.trim().toLowerCase();
const STATUS_BY_WORD = new Map(
  Object.entries(STATUS_WORD).map(([s, w]) => [norm(w), s as DeliveryStatus]),
);

/** The only moves the sheet makes; see the note at the top. */
const SHEET_MOVES: Record<string, DeliveryStatus[]> = {
  ready_to_ship: ['pending_ship', 'shipped'],
  pending_ship: ['ready_to_ship', 'shipped'],
};
/** Tracking is set from the sheet only while the parcel is in the pile. */
const TRACKING_EDITABLE = ['ready_to_ship', 'pending_ship'];
// Letters and digits first (so never = + - @, which spreadsheets and CSV
// exports read as a formula), then letters, digits, spaces, - and /.
const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 /-]{0,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Finished orders stay on the tab this long after their last change. */
export const FINISHED_DAYS = 30;
const FINISHED = ['completed', 'canceled', 'delivered'];

export type SheetOrder = {
  id: string;
  status: string;
  tracking_number: string | null;
  customer_id: string;
  name: string | null;
  cards: string[];
  created_at: Date | string;
  shipped_at: Date | string | null;
};

/** Open orders, plus finished ones from the last FINISHED_DAYS, oldest first.
 *  Oldest first so a new order joins at the bottom and no row moves under
 *  someone editing; the window is counted from 12am, so finished orders drop
 *  off only once a day, at 12am. Name only from the address: no phone or
 *  street in a shared sheet. */
export async function loadSheetOrders(
  container: MedusaContainer,
  now: Date = new Date(),
): Promise<SheetOrder[]> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const since = new Date(
    lastMidnightCutoff(now).getTime() - FINISHED_DAYS * DAY_MS,
  );
  const [open, finished] = await Promise.all([
    pageAll((o) => packs.listDeliveryOrders({ status: { $nin: FINISHED } }, o)),
    pageAll((o) =>
      packs.listDeliveryOrders(
        { status: FINISHED, updated_at: { $gte: since } },
        o,
      ),
    ),
  ]);
  const rows = await serializeDeliveryOrders(packs, [...open, ...finished]);
  return rows
    .map((o) => ({
      id: o.id,
      status: o.status,
      tracking_number: o.tracking_number,
      customer_id: o.customer_id,
      name: o.address.name,
      cards: o.items.map((i) => i.card?.name ?? 'Unknown card'),
      created_at: o.created_at,
      shipped_at: o.shipped_at,
    }))
    .sort(
      (a, b) =>
        +new Date(a.created_at) - +new Date(b.created_at) ||
        a.id.localeCompare(b.id),
    );
}

const myt = (d: Date | string | null): string | null =>
  d
    ? new Date(d)
        .toLocaleString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' })
        .slice(0, 16)
    : null;

/** "Charizard ex ×2, Pikachu": one entry per card, counted. */
export function cardsText(cards: string[]): string {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ');
}

/** A cell's text when it holds typed text; undefined when it holds a number,
 *  a formula or a tick box (a digits-only tracking number would have lost its
 *  leading zeros). An empty cell is ''. */
const typedText = (c: Cell | undefined): string | undefined => {
  const v = c?.userEnteredValue;
  if (!v || Object.keys(v).length === 0) return '';
  return v.stringValue?.trim();
};

export type OrderEdit =
  | {
      input: { status?: DeliveryStatus; tracking_number?: string | null };
    }
  | { note: string }
  | null;

/** What a sheet row asks for, judged against the order as it is now. Null
 *  when the row wasn't edited, or its hidden cells belong to another order.
 *  A note explains a refusal in the NOTE column. */
export function decideOrderEdit(row: Cell[], order: SheetOrder): OrderEdit {
  const synced = cellText(row[ORDER_COL.SYNC_STATUS]);
  if (synced === undefined) return null; // never written by the sync
  if (cellText(row[ORDER_COL.SYNC_ORDER]) !== order.id) return null; // re-sorted
  const syncedTracking = (cellText(row[ORDER_COL.SYNC_TRACKING]) ?? '').trim();
  const statusShown = typedText(row[ORDER_COL.STATUS]);
  const trackingShown = typedText(row[ORDER_COL.TRACKING]);
  const orderTracking = (order.tracking_number ?? '').trim();
  // A cell that already shows the order as it is now asks for nothing, even
  // when SYNCED is older: that is the sheet's own edit, saved by a pass whose
  // write was skipped or failed.
  const statusEdited =
    statusShown === undefined || norm(statusShown) !== norm(word(order.status));
  const trackingEdited =
    trackingShown === undefined || trackingShown !== orderTracking;
  if (!statusEdited && !trackingEdited) return null;

  // The order moved since the sheet was written, and the row doesn't show
  // it: the admin side wins.
  if (
    (statusEdited && order.status !== synced) ||
    (trackingEdited && orderTracking !== syncedTracking)
  ) {
    return {
      note: 'Changed in admin at the same time; kept the admin change.',
    };
  }

  const input: { status?: DeliveryStatus; tracking_number?: string | null } =
    {};
  if (trackingEdited) {
    if (trackingShown === undefined) {
      return { note: 'Tracking not saved: type it as text.' };
    }
    if (!TRACKING_EDITABLE.includes(order.status)) {
      return { note: 'Change the tracking number in admin.' };
    }
    if (!trackingShown) {
      return { note: 'Clear the tracking number in admin.' };
    }
    if (!TRACKING_RE.test(trackingShown)) {
      return {
        note: 'Tracking not saved: letters, digits, spaces, - and / only, up to 64.',
      };
    }
    input.tracking_number = trackingShown;
  }
  if (statusEdited) {
    const to =
      statusShown === undefined
        ? undefined
        : STATUS_BY_WORD.get(norm(statusShown));
    if (!to) return { note: 'Pick a status from the list.' };
    if (to === 'canceled') {
      return { note: 'Cancel in admin: it returns the cards to the vault.' };
    }
    if (!SHEET_MOVES[order.status]?.includes(to)) {
      return {
        note: 'Do this in admin: the sheet only moves Ready to ship, Pending to ship and Shipped.',
      };
    }
    const hasTracking = trackingEdited
      ? Boolean(input.tracking_number)
      : Boolean(orderTracking);
    const verdict = validateDeliveryStatusTransition(
      order.status,
      to,
      hasTracking,
    );
    if (verdict === 'tracking_required') {
      return { note: 'Shipped needs a tracking number: fill TRACKING too.' };
    }
    if (verdict !== 'ok') {
      return { note: `Can't go from ${word(order.status)} to ${word(to)}.` };
    }
    input.status = to;
  }
  return { input };
}
/** The tab as it should read. `notes` holds this pass's NOTE per order ('' to
 *  clear); otherwise a note stays while the order's status is unchanged. */
export function buildOrdersGrid(
  orders: SheetOrder[],
  existing: Grid,
  notes: ReadonlyMap<string, string>,
): Grid {
  const old = new Map<string, Cell[]>();
  for (const r of existing.slice(1)) {
    const id = cellText(r[ORDER_COL.ORDER]);
    if (id) old.set(id, r);
  }
  return [
    ORDER_HEADERS.map((h) => textCell(h)),
    ...orders.map((o): Cell[] => {
      const prev = old.get(o.id);
      const note = notes.has(o.id)
        ? textCell(notes.get(o.id))
        : prev && cellText(prev[ORDER_COL.SYNC_STATUS]) === o.status
          ? (prev[ORDER_COL.NOTE] ?? {})
          : {};
      return [
        textCell(o.id),
        textCell(myt(o.created_at)),
        textCell(o.name),
        textCell(cardsText(o.cards)),
        { userEnteredValue: { numberValue: o.cards.length } },
        textCell(word(o.status)),
        textCell(o.tracking_number),
        note,
        textCell(myt(o.shipped_at)),
        textCell(o.status),
        textCell(o.tracking_number),
        textCell(o.id),
      ];
    }),
  ];
}
