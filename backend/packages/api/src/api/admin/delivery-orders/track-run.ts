import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
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

const ACTOR = 'system:shipment-tracker';
const CARRIER_LABEL = { ninjavan: 'Ninja Van', poslaju: 'Pos Laju' } as const;

const messageOf = (e: unknown): string => {
  // A workflow refusal arrives as a serialized object carrying `message`.
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m ? m : String(e);
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
export async function runShipmentTracker(
  container: MedusaContainer,
  fetchFn: typeof fetch = fetch,
): Promise<ShipmentTrackerRun> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  const orders = (
    await pageAll((opts) =>
      packs.listDeliveryOrders({ status: 'shipped' }, opts),
    )
  ).filter((o) => o.tracking_number?.trim());
  const numbers = [...new Set(orders.map((o) => o.tracking_number as string))];
  const results = await trackShipments(numbers, fetchFn);

  // A number on more than one CUSTOMER's orders is a wrong entry on at least
  // one of them (prod 2026-10-30: NVMYNINJA002580543 on 2 customers), so the
  // carrier's answer can't be trusted for either: flag, never complete.
  // Several orders of one customer in one parcel is normal. Every status
  // counts — a completed order still owns its number.
  const owners = new Map<string, Set<string>>();
  if (numbers.length) {
    const sharing = await pageAll((opts) =>
      packs.listDeliveryOrders({ tracking_number: numbers }, opts),
    );
    for (const s of sharing) {
      const key = normalizeTrackingNumber(s.tracking_number as string);
      owners.set(key, (owners.get(key) ?? new Set()).add(s.customer_id));
    }
  }

  const run: ShipmentTrackerRun = {
    checked: 0,
    completed: [],
    problems: [],
    failed: [],
  };
  const checkedAt = new Date().toISOString();
  for (const o of orders) {
    const tracking = o.tracking_number as string;
    const key = normalizeTrackingNumber(tracking);
    const answer = results.get(key);
    if (!answer || answer instanceof Error) {
      run.failed.push(o.id);
      logger.warn(
        `[shipment-tracker] could not check ${o.id} (${tracking}): ${answer?.message ?? 'no result'}`,
      );
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
      logger.warn(
        `[shipment-tracker] ${o.id} (${tracking}): carrier lost its record this run, keeping the last answer`,
      );
      continue;
    }
    const r: TrackingResult =
      (owners.get(key)?.size ?? 0) > 1
        ? {
            ...answer,
            state: 'problem',
            event: "Same tracking number is on another customer's order",
          }
        : answer;
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
        (await completeDelivered(container, packs, o.id, tracking, r))
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
  return run;
}

async function completeDelivered(
  container: MedusaContainer,
  packs: PacksModuleService,
  orderId: string,
  tracking: string,
  r: TrackingResult,
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
  const at = r.delivered_at ? Date.parse(r.delivered_at) : NaN;
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
        reason: `${carrier} reports ${tracking} delivered${deliveredAt ? ` at ${deliveredAt}` : ''}`,
      },
    },
  });
  await notifyDeliveryChange(container, before, result, undefined);
  return true;
}
