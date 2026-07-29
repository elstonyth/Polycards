// src/api/store/credits/__tests__/topup-notify.unit.spec.ts
const runMock = jest.fn();

jest.mock('../../../../workflows/topup-credits', () => ({
  topUpCreditsWorkflow: () => ({ run: runMock }),
}));

// Imported AFTER the mock so the route picks up the mocked workflow.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require('../topup/route');

type Notif = Record<string, unknown>;

function harness() {
  const notifications: Notif[] = [];
  const scope = {
    resolve: () => ({
      createNotifications: async (n: Notif) => {
        notifications.push(n);
        return [n];
      },
    }),
  };
  const json = jest.fn();
  return {
    notifications,
    json,
    req: {
      auth_context: { actor_id: 'cus_1' },
      body: { amount: 50 },
      headers: { 'idempotency-key': 'key-1' },
      scope,
    } as never,
    res: { json } as never,
  };
}

beforeEach(() => {
  runMock.mockReset();
});

it('writes a topup_credited receipt for a real credit', async () => {
  runMock.mockResolvedValue({
    result: { amount: 50, reference: 'mock_abc', balance: 150, replayed: false },
  });
  const h = harness();

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({
    receiver_id: 'cus_1',
    channel: 'customer_feed',
    template: 'topup_credited',
    data: { amount_myr: 50, reference: 'mock_abc' },
    idempotency_key: 'topup:mock_abc',
  });
});

it('does NOT write a receipt for a replay — nothing was credited', async () => {
  runMock.mockResolvedValue({
    result: { amount: 50, reference: 'mock_abc', balance: 150, replayed: true },
  });
  const h = harness();

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(0);
  expect(h.json).toHaveBeenCalled();
});

it('a notification failure never fails a committed top-up', async () => {
  runMock.mockResolvedValue({
    result: { amount: 50, reference: 'mock_abc', balance: 150, replayed: false },
  });
  const h = harness();
  const req = h.req as unknown as { scope: { resolve: () => unknown } };
  req.scope.resolve = () => ({
    createNotifications: async () => {
      throw new Error('notification module down');
    },
  });

  await expect(POST(h.req, h.res)).resolves.toBeUndefined();
  expect(h.json).toHaveBeenCalledWith({
    amount: 50,
    reference: 'mock_abc',
    balance: 150,
    replayed: false,
  });
});
