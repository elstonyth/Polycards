import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  validateDeliveryStatusTransition,
  type DeliveryStatus,
} from '../../modules/packs/delivery';

export type UpdateDeliveryOrderInput = {
  order_id: string;
  status?: DeliveryStatus;
  tracking_number?: string | null;
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

export const updateDeliveryOrderStep = createStep(
  'update-delivery-order',
  async (input: UpdateDeliveryOrderInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

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
      await packs.updateDeliveryOrders([
        { id: order.id, tracking_number: nextTracking },
      ]);
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

    // Status transition — validate the move.
    const verdict = validateDeliveryStatusTransition(
      order.status as DeliveryStatus,
      input.status,
      !!nextTracking,
    );
    if (verdict === 'invalid_transition') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Cannot move a ${order.status} order to ${input.status}.`,
      );
    }
    if (verdict === 'tracking_required') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'A tracking number is required to mark an order shipped.',
      );
    }

    // Which pulls this order covers (needed for delivered/canceled side-effects).
    // Page to exhaustion — EVERY covered pull's status must be updated, so a
    // silent take:1000 truncation would strand pulls (correctness, not display).
    // MAX_PAGES bounds the loop so a misbehaving service that ignores `skip`
    // can't spin forever; a real delivery order is far under this cap.
    const PAGE = 1000;
    const MAX_PAGES = 100; // 100k items — defensive ceiling, not a real limit
    const items: Awaited<
      ReturnType<typeof packs.listDeliveryOrderItems>
    > = [];
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

    // Compute timestamp side-effects.
    const now = new Date();
    const patch: Record<string, unknown> = {
      id: order.id,
      status: input.status,
      tracking_number: nextTracking,
    };
    if (input.status === 'shipped') patch.shipped_at = now;
    if (input.status === 'delivered') patch.delivered_at = now;

    await packs.updateDeliveryOrders([patch]);

    // Pull side-effects: delivered → delivered (terminal); canceled → vaulted.
    let prevPullStatus: 'delivering' | 'delivered' | null = null;
    if (input.status === 'delivered' && pullIds.length) {
      prevPullStatus = 'delivering';
      await packs.updatePulls(
        pullIds.map((id) => ({ id, status: 'delivered' as const })),
      );
    } else if (input.status === 'canceled' && pullIds.length) {
      prevPullStatus = 'delivering';
      await packs.updatePulls(
        pullIds.map((id) => ({ id, status: 'vaulted' as const })),
      );
    }

    void logger;
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
  },
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
