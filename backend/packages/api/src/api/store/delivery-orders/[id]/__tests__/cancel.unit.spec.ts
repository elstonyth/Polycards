import { MedusaError } from '@medusajs/framework/utils';
import { POST as cancelOrder } from '../cancel/route';
import { updateDeliveryOrderWorkflow } from '../../../../../workflows/update-delivery-order';

// The workflow owns the real transition validation + compensation; the route's
// job is ownership, the pre-ship gate's friendly copy, and returning the
// refreshed order. Stub the workflow (its own behavior is covered elsewhere)
// and the serializer (passthrough) so this spec pins the ROUTE's contract.
jest.mock('../../../../../workflows/update-delivery-order', () => ({
  updateDeliveryOrderWorkflow: jest.fn(),
}));
jest.mock('../../../../../modules/packs/delivery-view', () => ({
  serializeDeliveryOrders: jest.fn(
    async (_packs: unknown, orders: unknown[]) => orders,
  ),
}));

const run = jest.fn();
(updateDeliveryOrderWorkflow as unknown as jest.Mock).mockReturnValue({ run });

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

const mkReq = (orders: any[], customerId = 'cus_1', id = 'do_1') => ({
  auth_context: { actor_id: customerId },
  params: { id },
  scope: {
    resolve: () => ({
      listDeliveryOrders: jest.fn(async () => orders),
    }),
  },
});

const order = (over: Record<string, unknown> = {}) => ({
  id: 'do_1',
  customer_id: 'cus_1',
  status: 'requested',
  ...over,
});

beforeEach(() => {
  run.mockReset().mockResolvedValue({});
});

describe('POST /store/delivery-orders/:id/cancel', () => {
  it('cancels a pre-ship order via the workflow and returns the refreshed order', async () => {
    const req = mkReq([order()]);
    const { res, out } = mkRes();

    await cancelOrder(req as any, res);

    expect(run).toHaveBeenCalledWith({
      input: { order_id: 'do_1', status: 'canceled' },
    });
    expect(out.body.order.id).toBe('do_1');
  });

  it('also allows cancel while packing', async () => {
    const { res } = mkRes();
    await cancelOrder(mkReq([order({ status: 'packing' })]) as any, res);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown order id without invoking the workflow', async () => {
    await expect(
      cancelOrder(mkReq([]) as any, mkRes().res),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(run).not.toHaveBeenCalled();
  });

  it("404s a foreign customer's order with the SAME error as unknown (no leak)", async () => {
    const foreign = cancelOrder(
      mkReq([order({ customer_id: 'cus_other' })]) as any,
      mkRes().res,
    ).catch((e: MedusaError) => e);
    const unknown = cancelOrder(mkReq([]) as any, mkRes().res).catch(
      (e: MedusaError) => e,
    );
    const [f, u] = (await Promise.all([foreign, unknown])) as [
      MedusaError,
      MedusaError,
    ];
    expect(f.type).toBe(MedusaError.Types.NOT_FOUND);
    expect(f.message).toBe(u.message); // indistinguishable — no existence oracle
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['shipped', /already shipped .*contact support/i],
    ['delivered', /already delivered .*contact support/i],
    ['canceled', /already canceled/i],
  ])('refuses a %s order with actionable copy', async (status, msg) => {
    await expect(
      cancelOrder(mkReq([order({ status })]) as any, mkRes().res),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(msg),
    });
    expect(run).not.toHaveBeenCalled();
  });
});
