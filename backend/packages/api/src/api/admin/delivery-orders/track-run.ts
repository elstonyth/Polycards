import { randomUUID } from 'node:crypto';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  normalizeTrackingNumber,
  trackShipments,
  type TrackingResult,
  type TrackingSnapshot,
} from '../../../modules/packs/shipment-tracking';
import { updateDeliveryOrderWorkflow } from '../../../workflows/update-delivery-order';
import { pageAll } from '../../utils/page-all';
import { notifyDeliveryChange } from './notify';

export type ShipmentTrackerRun = {
  /** Orders the carrier answered for (snapshot written). */
  checked: number;
  /** Orders moved shipped -> completed this run. */
  completed: string[];
  /** Returned, cancelled or failed-attempt parcels — flagged, not moved. */
  problems: string[];
  /** Orders whose check or completion threw — logged, retried next run. */
  failed: string[];
};

/** Another run (the job, or someone else's button) holds the tracker. */
export class ShipmentTrackerBusy extends Error {
  constructor() {
    super('A tracking check is already running. Try again in a few minutes.');
  }
}

const ACTOR = 'system:shipment-tracker';
const LOCK_KEY = 'shipment-tracker';
const CARRIER_LABEL = {
  ninjavan: 'Ninja Van',
  poslaju: 'Pos Laju',
  dhl_ecommerce: 'DHL eCommerce',
} as const;

const messageOf = (e: unknown): string => {
  // A workflow refusal arrives as a serialized object carrying `message`.
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m ? m : String(e);
};
const checkedAtMs = (o: { tracking_snapshot?: unknown }) =>
  Date.parse(
    (o.tracking_snapshot as TrackingSnapshot | null)?.checked_at ?? '',
  ) || 0;

type Pg = {
  raw: (
    sql: string,
    bindings: unknown[],
  ) => Promise<{ rows: { customer_id: string; key: string }[] }>;
};
type Locking = {
  acquire: (
    key: string,
    args: { ownerId: string; expire: number; awaitQueue: boolean },
  ) => Promise<void>;
  release: (key: string, args: { ownerId: string }) => Promise<unknown>;
};

// Shipment tracker (2026-10-30): checks every shipped order's tracking number
// with its carrier, stores what the carrier said on tracking_snapshot, and
// moves a delivered parcel to completed. Runs from the 2-hourly job and the
// admin "Check tracking" button.
//
// Completion goes through updateDeliveryOrderWorkflow — the same path as a
// staff click — so the order's cards flip to delivered, an audit row is
// written (as system:shipment-tracker) and the customer gets the same
// "delivered" notice. Only ever shipped -> completed: a returned or failed
// parcel is flagged for staff and never cancelled or moved back.
//
// One run at a time across every instance (the Valkey lock): two overlapping
// runs would double the Ninja Van calls past its ~100-per-IP limit and lock
// the tracker out for 10+ minutes. `budgetMs` stops starting carrier calls
// once spent; what is left is retried next run, oldest check first.
export async function runShipmentTracker(
  container: MedusaContainer,
  opts: {
    fetchFn?: typeof fetch;
    budgetMs?: number;
    /** The admin who pressed "Check tracking"; named in the audit reason. */
    actor?: string;
  } = {},
): Promise<ShipmentTrackerRun> {
  const budgetMs = opts.budgetMs ?? 10 * 60_000;
  const locking = container.resolve<Locking>(Modules.LOCKING);
  const ownerId = `${LOCK_KEY}:${randomUUID()}`;
  try {
    await locking.acquire(LOCK_KEY, {
      ownerId,
      // Outlives the budget, so a crashed run cannot block the next for long.
      expire: Math.ceil(budgetMs / 1000) + 300,
      awaitQueue: false,
    });
  } catch {
    throw new ShipmentTrackerBusy();
  }
  try {
    return await track(container, opts, Date.now() + budgetMs);
  } finally {
    await locking.release(LOCK_KEY, { ownerId }).catch(() => undefined);
  }
}

async function track(
  container: MedusaContainer,
  opts: { fetchFn?: typeof fetch; actor?: string },
  deadline: number,
): Promise<ShipmentTrackerRun> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  // Oldest check first (never-checked first of all): when Ninja Van's limit
  // or the budget cuts a run short, the orders it skipped go first next time.
  const orders = (
    await pageAll((page) =>
      packs.listDeliveryOrders({ status: 'shipped' }, page),
    )
  )
    .filter((o) => o.tracking_number?.trim())
    .sort((a, b) => checkedAtMs(a) - checkedAtMs(b));
  const keys = [
    ...new Set(
      orders.map((o) => normalizeTrackingNumber(o.tracking_number as string)),
    ),
  ];
  const results = await trackShipments(keys, opts.fetchFn ?? fetch, deadline);

  // A number on more than one CUSTOMER's orders is a wrong entry on at least
  // one of them (prod 2026-10-30: NVMYNINJA002580543 on 2 customers), so the
  // carrier's answer can't be trusted for either: flag, never complete.
  // Several orders of one customer in one parcel is normal. Every status
  // counts — a completed order still owns its number — and the match ignores
  // case and spaces, since staff input is only trimmed.
  const owners = new Map<string, Set<string>>();
  if (keys.length) {
    const pg = container.resolve<Pg>(ContainerRegistrationKeys.PG_CONNECTION);
    const { rows } = await pg.raw(
      `SELECT customer_id, upper(regexp_replace(tracking_number, '\\s', '', 'g')) AS key
         FROM delivery_order
        WHERE deleted_at IS NULL
          AND upper(regexp_replace(tracking_number, '\\s', '', 'g')) = ANY(?::text[])`,
      [keys],
    );
    for (const row of rows) {
      owners.set(
        row.key,
        (owners.get(row.key) ?? new Set()).add(row.customer_id),
      );
    }
  }

  const run: ShipmentTrackerRun = {
    checked: 0,
    completed: [],
    problems: [],
    failed: [],
  };
  // One log line per reason, not per order: after a 429 every remaining
  // Ninja Van order fails the same way.
  const notChecked = new Map<string, string[]>();
  const checkedAt = new Date().toISOString();
  for (const o of orders) {
    const tracking = o.tracking_number as string;
    const key = normalizeTrackingNumber(tracking);
    const answer = results.get(key);
    if (!answer || answer instanceof Error) {
      run.failed.push(o.id);
      const why = answer?.message ?? 'no result';
      notChecked.set(why, [...(notChecked.get(why) ?? []), o.id]);
      continue;
    }
    // Ninja Van once answered "not found" for a delivered parcel — a lone miss
    // in its own backend, not reproduced in ~190 later lookups. Keep what the
    // carrier said before instead of replacing it with "no record".
    const prev = o.tracking_snapshot as TrackingSnapshot | null;
    if (
      answer.state === 'not_found' &&
      prev?.tracking_number === tracking &&
      prev.state !== 'not_found'
    ) {
      run.failed.push(o.id);
      const why = 'carrier lost its record this run, keeping the last answer';
      notChecked.set(why, [...(notChecked.get(why) ?? []), o.id]);
      continue;
    }
    const r = trusted(answer, (owners.get(key)?.size ?? 0) > 1, o.created_at);
    run.checked++;
    try {
      const snapshot: TrackingSnapshot = {
        tracking_number: tracking,
        ...r,
        checked_at: checkedAt,
      };
      await packs.updateDeliveryOrders([
        {
          id: o.id,
          tracking_snapshot: snapshot as unknown as Record<string, unknown>,
        },
      ]);
      if (r.state === 'problem') run.problems.push(o.id);
      if (
        r.state === 'delivered' &&
        (await completeDelivered(
          container,
          packs,
          o.id,
          tracking,
          r,
          opts.actor,
        ))
      ) {
        run.completed.push(o.id);
      }
    } catch (e) {
      run.failed.push(o.id);
      logger.warn(
        `[shipment-tracker] could not update ${o.id} (${tracking}): ${messageOf(e)}`,
      );
    }
  }
  for (const [why, ids] of notChecked) {
    const shown = ids.slice(0, 5).join(', ');
    logger.warn(
      `[shipment-tracker] ${ids.length} order(s) not checked: ${why} (${shown}${ids.length > 5 ? ', …' : ''})`,
    );
  }
  return run;
}

// Turns a carrier answer the tracker must not act on into a flag for staff.
// `completed` is terminal, so "delivered" is believed only when the number
// belongs to this customer alone AND the carrier's delivery time is real and
// no earlier than the order itself — a mistyped number that matches someone
// else's parcel from last month would otherwise complete this order at once.
function trusted(
  answer: TrackingResult,
  shared: boolean,
  orderCreatedAt: Date | string,
): TrackingResult {
  if (shared) {
    return {
      ...answer,
      state: 'problem',
      event: "Same tracking number is on another customer's order",
    };
  }
  if (answer.state !== 'delivered') return answer;
  const at = Date.parse(answer.delivered_at ?? '');
  if (!Number.isFinite(at)) {
    return {
      ...answer,
      state: 'problem',
      event:
        'Carrier says delivered but gives no time, check and complete by hand',
    };
  }
  if (at < new Date(orderCreatedAt).getTime()) {
    return {
      ...answer,
      state: 'problem',
      event:
        'Carrier delivered this number before the order was placed, check the tracking number',
    };
  }
  return answer;
}

async function completeDelivered(
  container: MedusaContainer,
  packs: PacksModuleService,
  orderId: string,
  tracking: string,
  r: TrackingResult,
  actor: string | undefined,
): Promise<boolean> {
  // Re-read: staff may have moved the order or changed its number since the
  // list read, and the carrier answer is only about the number we checked.
  const [before] = await packs.listDeliveryOrders({ id: orderId }, { take: 1 });
  if (
    !before ||
    before.status !== 'shipped' ||
    before.tracking_number !== tracking
  ) {
    return false;
  }
  const at = Date.parse(r.delivered_at ?? '');
  const deliveredAt =
    Number.isFinite(at) && at <= Date.now()
      ? new Date(at).toISOString()
      : undefined;
  const carrier = r.carrier ? CARRIER_LABEL[r.carrier] : 'carrier';
  const { result } = await updateDeliveryOrderWorkflow(container).run({
    input: {
      order_id: orderId,
      status: 'completed',
      allowed_from: ['shipped'],
      delivered_at: deliveredAt,
      audit: {
        adminId: ACTOR,
        action: 'bulk_status',
        reason:
          `${carrier} reports ${tracking} delivered` +
          (deliveredAt ? ` at ${deliveredAt}` : '') +
          (actor ? ` (Check tracking pressed by ${actor})` : ''),
      },
    },
  });
  await notifyDeliveryChange(container, before, result, undefined);
  return true;
}
