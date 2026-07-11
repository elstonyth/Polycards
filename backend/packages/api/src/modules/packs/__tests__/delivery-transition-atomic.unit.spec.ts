import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';

/**
 * transitionDeliveryOrderStatus — the atomic, per-order-serialized status
 * seam (day-3 sim HIGH: concurrent double-cancel diverged an order to
 * 'requested' while its pulls were already re-vaulted, letting one physical
 * card be delivered into a SECOND live order).
 *
 * The contract pinned here, without a DB (same fake-`this` technique as
 * credit-balance.unit.spec.ts — @InjectTransactionManager reuses a provided
 * `sharedContext.transactionManager` and calls the original method):
 *
 *  1. A per-order `delivery:<id>` advisory lock is taken BEFORE the fresh
 *     status re-read, so concurrent transitions serialize.
 *  2. The transition is validated against the FRESH read under the lock —
 *     the losing double-cancel sees 'canceled' and refuses with a clean
 *     NOT_ALLOWED, writing NOTHING (no order write, no pull flip, no revert).
 *  3. A winning cancel writes the order row and re-vaults the pulls in the
 *     SAME transaction (shared context on both writes).
 *  4. A pull-flip failure propagates with exactly ONE order write issued —
 *     rollback owns the undo; there is no manual revert that could land
 *     after another run's terminal write.
 */

type OrderRow = { id: string; status: string } | undefined;

const fakeService = (order: OrderRow) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  const em = {
    execute: jest.fn(async (_q: string, _params?: unknown[]) => {
      ops.push('sql');
      return [];
    }),
  };
  const listDeliveryOrders = jest.fn(async () => {
    ops.push('read');
    return order ? [order] : [];
  });
  const updateDeliveryOrders = jest.fn(async () => {
    ops.push('write');
    return [];
  });
  const transitionPullStatus = jest.fn(async () => {
    ops.push('flip');
  });
  Object.assign(svc, {
    listDeliveryOrders,
    updateDeliveryOrders,
    transitionPullStatus,
  });
  const ctx = { transactionManager: em } as never;
  return {
    svc,
    em,
    ops,
    ctx,
    listDeliveryOrders,
    updateDeliveryOrders,
    transitionPullStatus,
  };
};

const cancelInput = {
  orderId: 'do_1',
  to: 'canceled' as const,
  trackingNumber: null,
  pullIds: ['pull_1', 'pull_2'],
};

describe('PacksModuleService.transitionDeliveryOrderStatus', () => {
  it('takes the per-order advisory lock BEFORE the fresh status read', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    await f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx);
    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(f.em.execute.mock.calls[0][1]).toEqual(['delivery:do_1']);
    expect(f.ops.indexOf('sql')).toBeLessThan(f.ops.indexOf('read'));
  });

  it('losing double-cancel: fresh read shows canceled → clean NOT_ALLOWED, NOTHING written', async () => {
    const f = fakeService({ id: 'do_1', status: 'canceled' });
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/canceled/),
    });
    // The loser must not touch the order row (the old revert-after-terminal-
    // write is exactly what stranded the order) nor the pulls.
    expect(f.updateDeliveryOrders).not.toHaveBeenCalled();
    expect(f.transitionPullStatus).not.toHaveBeenCalled();
  });

  it('winning cancel: order write + pull re-vault share ONE transaction', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    const result = await f.svc.transitionDeliveryOrderStatus(
      cancelInput,
      f.ctx,
    );
    expect(result).toEqual({ status: 'canceled' });
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'do_1', status: 'canceled' })],
      f.ctx,
    );
    expect(f.transitionPullStatus).toHaveBeenCalledWith(
      { ids: ['pull_1', 'pull_2'], from: 'delivering', to: 'vaulted' },
      f.ctx,
    );
  });

  it('delivered: stamps delivered_at and flips pulls delivering → delivered', async () => {
    const f = fakeService({ id: 'do_1', status: 'shipped' });
    await f.svc.transitionDeliveryOrderStatus(
      {
        orderId: 'do_1',
        to: 'delivered',
        trackingNumber: 'TRK1',
        pullIds: ['pull_1'],
      },
      f.ctx,
    );
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: 'delivered',
          delivered_at: expect.any(Date),
        }),
      ],
      f.ctx,
    );
    expect(f.transitionPullStatus).toHaveBeenCalledWith(
      { ids: ['pull_1'], from: 'delivering', to: 'delivered' },
      f.ctx,
    );
  });

  it('shipped: stamps shipped_at and does NOT touch pulls', async () => {
    const f = fakeService({ id: 'do_1', status: 'packing' });
    await f.svc.transitionDeliveryOrderStatus(
      {
        orderId: 'do_1',
        to: 'shipped',
        trackingNumber: 'TRK1',
        pullIds: ['pull_1'],
      },
      f.ctx,
    );
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: 'shipped',
          shipped_at: expect.any(Date),
        }),
      ],
      f.ctx,
    );
    expect(f.transitionPullStatus).not.toHaveBeenCalled();
  });

  it('shipped without tracking refuses with INVALID_DATA before any write', async () => {
    const f = fakeService({ id: 'do_1', status: 'packing' });
    await expect(
      f.svc.transitionDeliveryOrderStatus(
        {
          orderId: 'do_1',
          to: 'shipped',
          trackingNumber: null,
          pullIds: [],
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
    expect(f.updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('a pull-flip failure propagates with exactly ONE order write (rollback owns the undo)', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    f.transitionPullStatus.mockRejectedValueOnce(
      new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards changed state — refresh and try again.',
      ),
    );
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    // No compensating second write — a manual revert here is what produced
    // the requested-order/vaulted-pull divergence.
    expect(f.updateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('proof_images pass through wholesale when provided', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    await f.svc.transitionDeliveryOrderStatus(
      { ...cancelInput, to: 'packing', pullIds: [], proofImages: ['a.webp'] },
      f.ctx,
    );
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [expect.objectContaining({ proof_images: ['a.webp'] })],
      f.ctx,
    );
  });

  it('404s an unknown order without writing', async () => {
    const f = fakeService(undefined);
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(f.updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('empty pullIds on cancel skips the flip (no zero-id UPDATE)', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    await f.svc.transitionDeliveryOrderStatus(
      { ...cancelInput, pullIds: [] },
      f.ctx,
    );
    expect(f.transitionPullStatus).not.toHaveBeenCalled();
  });
});
