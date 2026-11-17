import {
  submitHeldWithdrawal,
  denyHeldWithdrawal,
} from '../../../../../modules/packs/gateway-withdrawal';
import { POST as APPROVE } from '../[id]/approve/route';
import { POST as DENY } from '../[id]/deny/route';

const permission = { allowed: true };
jest.mock('@medusajs/framework', () => ({
  hasPermission: jest.fn(async () => permission.allowed),
}));

jest.mock('../../../../../modules/packs/gateway-withdrawal', () => ({
  submitHeldWithdrawal: jest.fn(),
  denyHeldWithdrawal: jest.fn(),
}));

/**
 * The two routes are now three statements each: read the request, call the
 * operation, answer with what it returned. Every money decision they used to
 * make lives in modules/packs/gateway-withdrawal.ts and is proven against a
 * real Postgres in modules/packs/__tests__/held-withdrawal.integration.spec.ts
 * (which replaced this file's ancestor, approve-deny.unit.spec.ts).
 *
 * What is left for a route test is the REQUEST-to-ARGUMENT mapping, and it is
 * not decorative: `payerIp` becomes the gateway's `ipAddress`, whose whole job
 * is being un-forgeable, and `adminId` is the actor every audit line names.
 * Wire either to the wrong source — a body field, a header — and no
 * module-tier test can see it, because the operation would still be handed a
 * perfectly well-formed string. There is no http suite over these two routes
 * to catch it either.
 *
 * Auth is NOT exercised here (no router, no middleware chain) — these routes
 * are protected by the framework's blanket '/admin' guard like every sibling.
 * Nor is the rate-limit registration:
 * api/__tests__/admin-rate-limit-coverage.unit.spec.ts already fails when ANY
 * admin route.ts exports a mutation method with no adminActionRateLimit
 * matcher covering its URL.
 */
const approveOp = submitHeldWithdrawal as jest.Mock;
const denyOp = denyHeldWithdrawal as jest.Mock;

const mkReq = (over: Record<string, unknown> = {}) =>
  ({
    scope: { resolve: () => undefined },
    params: { id: 'gpw_1' },
    auth_context: { actor_id: 'usr_admin_1', app_metadata: { roles: ['role_reviewer'] } },
    headers: {},
    ip: '10.0.0.7',
    ...over,
  }) as never;

const mkRes = () => {
  const out: { body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  return {
    res: {
      setHeader: (k: string, v: string) => {
        out.headers[k] = v;
      },
      json: (b: unknown) => {
        out.body = b;
      },
    } as never,
    out,
  };
};

beforeEach(() => {
  approveOp.mockReset();
  denyOp.mockReset();
});

it('approve calls submitHeldWithdrawal with the row, the actor and the payer IP, and answers verbatim', async () => {
  const answer = {
    id: 'gpw_1',
    status: 'pending',
    transaction_id: 'W2026081200000001',
    approved: true,
  };
  approveOp.mockResolvedValue(answer);
  const req = mkReq();
  const { res, out } = mkRes();

  await APPROVE(req, res);

  expect(approveOp).toHaveBeenCalledTimes(1);
  const [scope, input] = approveOp.mock.calls[0];
  expect(scope).toBe((req as unknown as { scope: unknown }).scope);
  expect(input).toEqual({
    withdrawalId: 'gpw_1',
    adminId: 'usr_admin_1',
    // payerIpOf(req): req.ip first, then x-forwarded-for, then the socket.
    payerIp: '10.0.0.7',
  });
  // Verbatim — the same object, not a re-shaped copy, so the admin SPA's
  // WithdrawalApproveResult cannot drift from what the operation returns.
  expect(out.body).toBe(answer);
  expect(out.headers['Cache-Control']).toBe('no-store');
});

it('approve falls back to x-forwarded-for when Express has no req.ip', async () => {
  approveOp.mockResolvedValue({
    id: 'gpw_1',
    status: 'pending',
    transaction_id: null,
    approved: true,
  });
  await APPROVE(
    mkReq({
      ip: undefined,
      headers: { 'x-forwarded-for': '203.0.113.9, 10.1.1.1' },
    }),
    mkRes().res,
  );
  expect(approveOp.mock.calls[0][1].payerIp).toBe('203.0.113.9');
});

it('deny calls denyHeldWithdrawal with the row and the actor, and answers verbatim', async () => {
  const answer = { id: 'gpw_1', status: 'failed', refunded: true };
  denyOp.mockResolvedValue(answer);
  const req = mkReq();
  const { res, out } = mkRes();

  await DENY(req, res);

  expect(denyOp).toHaveBeenCalledTimes(1);
  const [scope, input] = denyOp.mock.calls[0];
  expect(scope).toBe((req as unknown as { scope: unknown }).scope);
  // No payer IP: deny never reaches the gateway.
  expect(input).toEqual({ withdrawalId: 'gpw_1', adminId: 'usr_admin_1' });
  expect(out.body).toBe(answer);
  expect(out.headers['Cache-Control']).toBe('no-store');
});

it('neither route swallows the operation’s MedusaError — the status code is its type', async () => {
  approveOp.mockRejectedValue(new Error('boom'));
  denyOp.mockRejectedValue(new Error('boom'));
  await expect(APPROVE(mkReq(), mkRes().res)).rejects.toThrow('boom');
  await expect(DENY(mkReq(), mkRes().res)).rejects.toThrow('boom');
});

describe('approve with verify_device_peers (ADR 0018)', () => {
  const packsWith = () => ({
    listGatewayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1', customer_id: 'cus_later' }]),
    sharedDeviceHoldPeers: jest.fn().mockResolvedValue(['cus_first']),
    verifyDevicePeers: jest.fn().mockResolvedValue(undefined),
  });

  it('stamps the current peers as one household after a successful approve', async () => {
    approveOp.mockResolvedValue({ id: 'gpw_1', status: 'pending', approved: true });
    const packs = packsWith();
    const req = mkReq({ scope: { resolve: () => packs }, body: { verify_device_peers: true } });
    await APPROVE(req, mkRes().res);
    expect(packs.verifyDevicePeers).toHaveBeenCalledWith({
      customerId: 'cus_later',
      peerIds: ['cus_first'],
      adminId: 'usr_admin_1',
      reason: 'one household, confirmed approving held withdrawal gpw_1',
    });
  });

  it('stamps nothing without the tick, or when the approve is refused', async () => {
    const packs = packsWith();
    approveOp.mockResolvedValue({ id: 'gpw_1', status: 'pending', approved: true });
    await APPROVE(mkReq({ scope: { resolve: () => packs } }), mkRes().res);
    // An approve that did nothing (already handled) stamps nothing either.
    approveOp.mockResolvedValue({ id: 'gpw_1', status: 'failed', approved: false });
    await APPROVE(mkReq({ scope: { resolve: () => packs }, body: { verify_device_peers: true } }), mkRes().res);
    approveOp.mockRejectedValue(new Error('frozen'));
    await expect(
      APPROVE(mkReq({ scope: { resolve: () => packs }, body: { verify_device_peers: true } }), mkRes().res),
    ).rejects.toThrow('frozen');
    expect(packs.verifyDevicePeers).not.toHaveBeenCalled();
  });
});

it('a failed household stamp never turns a sent payout into an error', async () => {
  const answer = { id: 'gpw_1', status: 'pending', approved: true };
  approveOp.mockResolvedValue(answer);
  const warn = jest.fn();
  const packs = {
    listGatewayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1', customer_id: 'cus_later' }]),
    sharedDeviceHoldPeers: jest.fn().mockResolvedValue(['cus_first']),
    verifyDevicePeers: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'E1' })),
  };
  const { res, out } = mkRes();
  await APPROVE(mkReq({ scope: { resolve: (k: string) => (k === 'logger' ? { warn } : packs) }, body: { verify_device_peers: true } }), res);
  expect(out.body).toBe(answer);
  expect(warn).toHaveBeenCalledTimes(1);
});

it('refuses the household tick, before paying, for an approver without the bank read policy', async () => {
  permission.allowed = false;
  try {
    approveOp.mockResolvedValue({ id: 'gpw_1', status: 'pending', approved: true });
    await expect(
      APPROVE(mkReq({ body: { verify_device_peers: true } }), mkRes().res),
    ).rejects.toThrow(/needs access to bank details/);
    expect(approveOp).not.toHaveBeenCalled();
  } finally {
    permission.allowed = true;
  }
});
