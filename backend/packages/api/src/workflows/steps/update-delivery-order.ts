import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import type { DeliveryStatus } from '../../modules/packs/delivery';

export type UpdateDeliveryOrderInput = {
  order_id: string;
  status?: DeliveryStatus;
  tracking_number?: string | null;
  proof_images?: string[];
};

export type UpdateDeliveryOrderResult = {
  order_id: string;
  status: DeliveryStatus;
};

type CompensateData =
  | {
      orderId: string;
      prev: {
        status: DeliveryStatus;
        tracking_number: string | null;
        shipped_at: Date | null;
        delivered_at: Date | null;
      };
      pullIds: string[];
      prevPullStatus: 'delivering' | 'delivered' | null; // null = unchanged
    }
  | undefined;

export const updateDeliveryOrderInvoke = async (
  input: UpdateDeliveryOrderInput,
  { container }: { container: MedusaContainer },
) => {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const [order] = await packs.listDeliveryOrders(
    { id: input.order_id },
    { take: 1 },
  );
  if (!order) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Delivery order '${input.order_id}' not found.`,
    );
  }

  const nextTracking =
    input.tracking_number !== undefined
      ? input.tracking_number
      : order.tracking_number;

  // Tracking-only update (no status change) — just patch + return.
  if (!input.status || input.status === order.status) {
    // Record<string, unknown> so the json proof_images column (DML-typed as
    // Record) accepts our string[]. Array replaces wholesale (Medusa assign
    // merges POJOs, replaces arrays), so [] cleanly clears every photo.
    const trackingPatch: Record<string, unknown> = {
      id: order.id,
      tracking_number: nextTracking,
    };
    if (input.proof_images !== undefined) {
      trackingPatch.proof_images = input.proof_images;
    }
    await packs.updateDeliveryOrders([trackingPatch]);
    return new StepResponse(
      { order_id: order.id, status: order.status as DeliveryStatus },
      {
        orderId: order.id,
        prev: {
          status: order.status as DeliveryStatus,
          tracking_number: order.tracking_number ?? null,
          shipped_at: order.shipped_at ?? null,
          delivered_at: order.delivered_at ?? null,
        },
        pullIds: [],
        prevPullStatus: null,
      } satisfies CompensateData,
    );
  }

  // Which pulls this order covers (needed for delivered/canceled side-effects).
  // Page to exhaustion — EVERY covered pull's status must be updated, so a
  // silent take:1000 truncation would strand pulls (correctness, not display).
  // MAX_PAGES bounds the loop so a misbehaving service that ignores `skip`
  // can't spin forever; a real delivery order is far under this cap.
  const PAGE = 1000;
  const MAX_PAGES = 100; // 100k items — defensive ceiling, not a real limit
  const items: Awaited<ReturnType<typeof packs.listDeliveryOrderItems>> = [];
  let page = 0;
  for (; page < MAX_PAGES; page++) {
    const batch = await packs.listDeliveryOrderItems(
      { delivery_order_id: order.id },
      { take: PAGE, skip: page * PAGE },
    );
    items.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (page >= MAX_PAGES) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Delivery order ${order.id} exceeded ${MAX_PAGES * PAGE} items — ` +
        'refusing to proceed with a possibly-truncated pull set.',
    );
  }
  const pullIds = items.map((i) => i.pull_id);

  // Status transition — ONE atomic, per-order-serialized service call: fresh
  // re-read + validation + order write + pull flip commit or roll back
  // together under a `delivery:<id>` advisory lock (see
  // transitionDeliveryOrderStatus). No manual undo here — the transaction
  // owns it, so a losing concurrent cancel refuses cleanly instead of
  // reverting the order row after the winner's terminal write (day-3 sim
  // divergence: order stranded at 'requested' with its pulls re-vaulted).
  await packs.transitionDeliveryOrderStatus({
    orderId: order.id,
    to: input.status,
    trackingNumber: nextTracking ?? null,
    proofImages: input.proof_images,
    pullIds,
  });

  const prevPullStatus: 'delivering' | null =
    pullIds.length && (input.status === 'delivered' || input.status === 'canceled')
      ? 'delivering'
      : null;
  return new StepResponse({ order_id: order.id, status: input.status }, {
    orderId: order.id,
    prev: {
      status: order.status as DeliveryStatus,
      tracking_number: order.tracking_number ?? null,
      shipped_at: order.shipped_at ?? null,
      delivered_at: order.delivered_at ?? null,
    },
    pullIds,
    prevPullStatus,
  } satisfies CompensateData);
};

export const updateDeliveryOrderStep = createStep(
  'update-delivery-order',
  updateDeliveryOrderInvoke,
  // COMPENSATION — restore the order row and pull statuses.
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updateDeliveryOrders([
      {
        id: data.orderId,
        status: data.prev.status,
        tracking_number: data.prev.tracking_number,
        shipped_at: data.prev.shipped_at,
        delivered_at: data.prev.delivered_at,
      },
    ]);
    if (data.prevPullStatus && data.pullIds.length) {
      await packs.updatePulls(
        data.pullIds.map((id) => ({ id, status: data.prevPullStatus! })),
      );
    }
  },
);

export default updateDeliveryOrderStep;
