import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import { updateDeliveryOrderInvoke } from '../update-delivery-order';
import { DEFAULT_USD_MYR } from '../../../modules/packs/pricing';

/**
 * update-delivery-order step — the transition path must delegate to the
 * atomic transitionDeliveryOrderStatus seam and NEVER write the order row
 * itself on failure. The old shape (write status, flip pulls, manually
 * revert on flip failure) is what let a losing concurrent cancel strand the
 * order at 'requested' while its pulls were already re-vaulted (day-3 sim
 * HIGH — double-ship of one physical card).
 */

const ORDER = {
  id: 'do_1',
  status: 'requested',
  tracking_number: null,
  shipped_at: null,
  delivered_at: null,
};

const makePacks = (over: Record<string, unknown> = {}) => ({
  listDeliveryOrders: jest.fn(async () => [ORDER]),
  listDeliveryOrderItems: jest.fn(async () => [
    { pull_id: 'pull_1' },
    { pull_id: 'pull_2' },
  ]),
  updateDeliveryOrders: jest.fn(async () => []),
  transitionDeliveryOrderStatus: jest.fn(async () => ({
    status: 'canceled',
  })),
  ...over,
});

const containerFor = (packs: unknown) =>
  ({ resolve: () => packs }) as unknown as MedusaContainer;

describe('updateDeliveryOrderInvoke', () => {
  it('routes a cancel through the atomic transition seam with the covered pulls', async () => {
    const packs = makePacks();
    const res = await updateDeliveryOrderInvoke(
      { order_id: 'do_1', status: 'canceled' },
      { container: containerFor(packs) },
    );
    expect(packs.transitionDeliveryOrderStatus).toHaveBeenCalledWith({
      orderId: 'do_1',
      to: 'canceled',
      trackingNumber: null,
      proofImages: undefined,
      pullIds: ['pull_1', 'pull_2'],
      // Task 8: the step resolves fx before this call (never inside the
      // transactional seam — see update-delivery-order.ts's comment). The
      // fake `packs` has no listFxRates, so resolveFxRate's try/catch falls
      // through to the DEFAULT_USD_MYR display fallback deterministically.
      fx: DEFAULT_USD_MYR,
    });
    // The step itself must not write the order row on a transition — the
    // atomic seam owns the write (updateDeliveryOrders is tracking-only).
    expect(packs.updateDeliveryOrders).not.toHaveBeenCalled();
    expect(res.output).toEqual({ order_id: 'do_1', status: 'canceled' });
  });

  it('marks compensation to revert covered pulls to delivering on a completed transition', async () => {
    // Guards the line-127 rename (input.status === 'delivered' -> 'completed'):
    // without it, a failed completed transition's compensation would silently
    // skip restoring the pulls to 'delivering' (prevPullStatus stays null).
    const packs = makePacks({
      transitionDeliveryOrderStatus: jest.fn(async () => ({
        status: 'completed',
      })),
    });
    const res = await updateDeliveryOrderInvoke(
      { order_id: 'do_1', status: 'completed' },
      { container: containerFor(packs) },
    );
    expect(res.compensateInput).toMatchObject({
      pullIds: ['pull_1', 'pull_2'],
      prevPullStatus: 'delivering',
    });
  });

  it('a refused transition propagates with NO revert write from the step', async () => {
    const packs = makePacks({
      transitionDeliveryOrderStatus: jest.fn(async () => {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          'Cannot move a canceled order to canceled.',
        );
      }),
    });
    await expect(
      updateDeliveryOrderInvoke(
        { order_id: 'do_1', status: 'canceled' },
        { container: containerFor(packs) },
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    // The old manual undo wrote the order row back to its stale pre-read
    // status AFTER the winner's terminal write — pin that it is gone.
    expect(packs.updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('tracking-only update patches directly without the transition seam', async () => {
    const packs = makePacks();
    await updateDeliveryOrderInvoke(
      { order_id: 'do_1', tracking_number: 'TRK9' },
      { container: containerFor(packs) },
    );
    expect(packs.updateDeliveryOrders).toHaveBeenCalledWith([
      { id: 'do_1', tracking_number: 'TRK9' },
    ]);
    expect(packs.transitionDeliveryOrderStatus).not.toHaveBeenCalled();
  });

  it('404s an unknown order before touching anything', async () => {
    const packs = makePacks({ listDeliveryOrders: jest.fn(async () => []) });
    await expect(
      updateDeliveryOrderInvoke(
        { order_id: 'do_missing', status: 'canceled' },
        { container: containerFor(packs) },
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(packs.transitionDeliveryOrderStatus).not.toHaveBeenCalled();
    expect(packs.updateDeliveryOrders).not.toHaveBeenCalled();
  });
});
