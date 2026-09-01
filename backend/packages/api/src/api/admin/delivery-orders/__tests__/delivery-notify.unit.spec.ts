// src/api/admin/delivery-orders/__tests__/delivery-notify.unit.spec.ts
import { Modules } from '@medusajs/framework/utils';

const runMock = jest.fn();

jest.mock('../../../../workflows/update-delivery-order', () => ({
  updateDeliveryOrderWorkflow: () => ({ run: runMock }),
}));

// Imported AFTER the mock so the route picks up the mocked workflow.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require('../[id]/route');

type Notif = Record<string, unknown>;

function harness(order: Record<string, unknown> | undefined) {
  const notifications: Notif[] = [];
  const audits: Record<string, unknown>[] = [];
  const packsService = {
    listDeliveryOrders: async () => (order ? [order] : []),
    // The single-order route audits a status change (mirrors bulk); capture
    // the row so the notify specs can also pin "audited once" / "not audited".
    createAdminActionAudits: async (rows: Record<string, unknown>[]) => {
      audits.push(...rows);
      return rows;
    },
  };
  const scope = {
    resolve: (key: string) => {
      if (key === Modules.NOTIFICATION) {
        return {
          createNotifications: async (n: Notif) => {
            notifications.push(n);
            return [n];
          },
        };
      }
      return packsService;
    },
  };
  const json = jest.fn();
  return {
    notifications,
    audits,
    // A body with none of status/tracking_number/proof_images fails
    // coerceDeliveryUpdateBody's "provide something" guard before this
    // route's notification wiring is ever reached. `status: 'shipped'` is
    // inert here (the workflow is mocked and ignores `input`) and, unlike a
    // `tracking_number` key, doesn't disturb the input.tracking_number
    // undefined check the route uses to decide "unchanged".
    req: {
      params: { id: 'do_1' },
      body: { status: 'shipped' },
      scope,
      auth_context: { actor_id: 'admin_1' },
    } as never,
    res: { json } as never,
    json,
  };
}

beforeEach(() => {
  runMock.mockReset();
});

it('notifies the order owner when an admin ships it', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'shipped' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'processed',
    tracking_number: 'TRK1',
  });

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({
    receiver_id: 'cus_1',
    channel: 'customer_feed',
    template: 'delivery_status',
    data: { order_id: 'do_1', status: 'shipped', tracking_number: 'TRK1' },
    idempotency_key: 'delivery:do_1:shipped',
  });
  // One audit row per status change, same shape as the bulk route.
  expect(h.audits).toEqual([
    expect.objectContaining({
      admin_id: 'admin_1',
      entity_type: 'delivery_order',
      entity_id: 'do_1',
      before: { status: 'processed' },
      after: { status: 'shipped' },
    }),
  ]);
  expect(h.json).toHaveBeenCalledWith({
    order_id: 'do_1',
    status: 'shipped',
  });
});

it('does NOT notify a tracking-only update (status unchanged)', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'shipped' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'shipped',
    tracking_number: null,
  });

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(0);
  expect(h.json).toHaveBeenCalled();
});

it('does NOT notify on processed', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'processed' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'requested',
    tracking_number: null,
  });

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(0);
});

it('a notification failure never fails the committed status change', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'completed' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'shipped',
    tracking_number: null,
  });
  // Replace the notification module with one that throws.
  const scope = h.req as unknown as { scope: { resolve: (k: string) => unknown } };
  const original = scope.scope.resolve;
  scope.scope.resolve = (key: string) =>
    key === Modules.NOTIFICATION
      ? {
          createNotifications: async () => {
            throw new Error('notification module down');
          },
        }
      : original(key);

  await expect(POST(h.req, h.res)).resolves.toBeUndefined();
  expect(h.json).toHaveBeenCalledWith({
    order_id: 'do_1',
    status: 'completed',
  });
});
