/**
 * The payout-callback state machine, driven once through a fake platform
 * adapter. The per-platform specs (api/hooks/{tgpay,the7pay,a3pay,gp365})
 * cover each adapter's verify, decode and ack bytes end to end.
 */
jest.mock('../gateway-withdrawal', () => ({
  refundWithdrawal: jest.fn().mockResolvedValue({ replayed: false }),
  applyWithdrawalOutcome: jest.fn().mockResolvedValue({ replayed: false }),
}));
jest.mock('../ops-alert', () => ({ alertOps: jest.fn() }));

import { alertOps } from '../ops-alert';
import { applyWithdrawalOutcome, refundWithdrawal } from '../gateway-withdrawal';
import {
  handleWithdrawalCallback,
  type CallbackRow,
  type WithdrawalNotice,
} from '../withdrawal-callback';

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'gpw_1',
    customer_id: 'cus_1',
    merchant_transaction_id: 'PC-1',
    gateway_transaction_id: 'T-1',
    amount: '100',
    status: 'pending',
    gateway: 'tgpay',
    audit_ack_note: null,
    ...over,
  }) as unknown as CallbackRow;

const SETTLED_AT = new Date('2026-11-17T00:00:00Z');

function notice(over: Partial<WithdrawalNotice> = {}): WithdrawalNotice {
  return {
    kind: 'tgpay',
    label: 'Fake',
    find: { gatewayTransactionId: 'T-1', merchantTransactionId: 'PC-1' },
    rawStatus: 'RAW',
    state: 'success',
    gatewayTransactionId: (r) => r.gateway_transaction_id ?? 'T-cb',
    paidAmount: () => 100,
    failureReason: () => 'fake failed',
    amountMismatch: () => null,
    settlement: (_r, id) => ({ gatewayRef: id, settledAt: SETTLED_AT }),
    ...over,
  };
}

function harness(found: CallbackRow[][]) {
  const packs = {
    listGatewayWithdrawals: jest.fn(),
    updateGatewayWithdrawals: jest.fn().mockResolvedValue(undefined),
  };
  for (const rows of found) packs.listGatewayWithdrawals.mockResolvedValueOnce(rows);
  packs.listGatewayWithdrawals.mockResolvedValue([]);
  const logger = { warn: jest.fn(), error: jest.fn() };
  const scope = {
    resolve: <T,>(k: string) => (k === 'logger' ? logger : packs) as T,
  };
  return { packs, logger, scope };
}

beforeEach(() => jest.clearAllMocks());

const OK = { status: 200, body: 'success' };

test('looks up their id first, then ours, each scoped to the gateway', async () => {
  const h = harness([[], [row()]]);
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(h.packs.listGatewayWithdrawals.mock.calls).toEqual([
    [{ gateway_transaction_id: 'T-1', gateway: 'tgpay' }, { take: 1 }],
    [{ merchant_transaction_id: 'PC-1', gateway: 'tgpay' }, { take: 1 }],
  ]);
  expect(applyWithdrawalOutcome).toHaveBeenCalledTimes(1);
});

test('an unknown payout is acknowledged and changes nothing', async () => {
  const h = harness([]);
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(h.logger.error).toHaveBeenCalledWith(
    '[tgpay] verified withdrawal callback for UNKNOWN payout PC-1 (status RAW) — nothing changed; the sweep will requery',
  );
  expect(refundWithdrawal).not.toHaveBeenCalled();
  expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
});

test("another gateway's row is acknowledged and ignored", async () => {
  const h = harness([[row({ gateway: 'a3pay' })]]);
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(h.logger.error.mock.calls[0][0]).toMatch(/belongs to gateway "a3pay" — ignored/);
  expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
});

test('a repeat of what the row already says is acknowledged quietly', async () => {
  const h = harness([[row({ status: 'settled' })]]);
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(h.logger.error).not.toHaveBeenCalled();
  expect(alertOps).not.toHaveBeenCalled();
  expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
});

test('a success on a refunded row logs, alerts ops and notes the row', async () => {
  const h = harness([[row({ status: 'failed' })]]);
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(h.logger.error.mock.calls[0][0]).toBe(
    '[tgpay] withdrawal PC-1 callback says RAW (success) but the row is already failed — possible double payment, investigate (gateway T-1)',
  );
  expect(alertOps).toHaveBeenCalledWith(
    h.scope,
    'payout-contradiction',
    'Fake says payout PC-1 is success, but our row is already failed — the customer may have been refunded AND paid. Investigate Fake T-1.',
  );
  expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'gpw_1', audited_at: expect.any(Date) }),
  );
  expect(refundWithdrawal).not.toHaveBeenCalled();
  expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
});

test('a contradiction note that cannot be written still acknowledges', async () => {
  const h = harness([[row({ status: 'failed' })]]);
  h.packs.updateGatewayWithdrawals.mockRejectedValue(new Error('db down'));
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(h.logger.error.mock.calls[1][0]).toBe(
    '[tgpay] could not record the contradiction on PC-1: db down',
  );
});

test('still pending at the gateway: acknowledged, nothing moves', async () => {
  const h = harness([[row()]]);
  await expect(
    handleWithdrawalCallback(h.scope, notice({ state: 'pending' })),
  ).resolves.toEqual(OK);
  expect(refundWithdrawal).not.toHaveBeenCalled();
  expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
});

test('failed: refunds the pending row with the adapter reason', async () => {
  const h = harness([[row()]]);
  await expect(
    handleWithdrawalCallback(h.scope, notice({ state: 'failed' })),
  ).resolves.toEqual(OK);
  expect(refundWithdrawal).toHaveBeenCalledWith(
    h.scope,
    expect.objectContaining({ id: 'gpw_1' }),
    null,
    'pending',
    'fake failed',
  );
});

test('failed: a refund that throws answers 500 so the gateway retries', async () => {
  const h = harness([[row()]]);
  (refundWithdrawal as jest.Mock).mockRejectedValueOnce(new Error('lock'));
  await expect(
    handleWithdrawalCallback(h.scope, notice({ state: 'failed' })),
  ).resolves.toEqual({ status: 500, body: 'error' });
  expect(h.logger.error).toHaveBeenCalledWith(
    '[tgpay] failed to refund withdrawal PC-1: lock',
  );
});

test.each([
  [false, 0],
  [true, 1],
])('success with a mismatched amount logs it (alert=%s)', async (alert, alerts) => {
  const h = harness([[row()]]);
  await handleWithdrawalCallback(
    h.scope,
    notice({ amountMismatch: () => ({ note: 'paid 99, debited 100', alert }) }),
  );
  expect(h.logger.error).toHaveBeenCalledWith('[tgpay] paid 99, debited 100');
  expect((alertOps as jest.Mock).mock.calls).toHaveLength(alerts);
  expect(applyWithdrawalOutcome).toHaveBeenCalledTimes(1);
});

test("success: settles with the adapter's settlement and their id", async () => {
  const h = harness([[row()]]);
  await expect(handleWithdrawalCallback(h.scope, notice())).resolves.toEqual(OK);
  expect(applyWithdrawalOutcome).toHaveBeenCalledWith(
    h.scope,
    expect.objectContaining({ id: 'gpw_1' }),
    { gatewayRef: 'T-1', settledAt: SETTLED_AT },
  );
  expect(h.logger.error).not.toHaveBeenCalled();
});

test('a failure on a settled row is a contradiction without the refunded-and-paid warning', async () => {
  const h = harness([[row({ status: 'settled' })]]);
  await expect(
    handleWithdrawalCallback(h.scope, notice({ state: 'failed' })),
  ).resolves.toEqual(OK);
  expect(h.logger.error.mock.calls[0][0]).toBe(
    '[tgpay] withdrawal PC-1 callback says RAW (failed) but the row is already settled — possible double payment, investigate (gateway T-1)',
  );
  expect(alertOps).toHaveBeenCalledWith(
    h.scope,
    'payout-contradiction',
    'Fake says payout PC-1 is failed, but our row is already settled. Investigate Fake T-1.',
  );
  expect(refundWithdrawal).not.toHaveBeenCalled();
  expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
});

test('a paid amount that cannot be read still acknowledges the contradiction', async () => {
  const h = harness([[row({ status: 'failed' })]]);
  const answer = await handleWithdrawalCallback(
    h.scope,
    notice({
      paidAmount: () => {
        throw new Error('no fx lock');
      },
    }),
  );
  expect(answer).toEqual(OK);
  expect(h.logger.error).toHaveBeenCalledWith(
    '[tgpay] could not record the contradiction on PC-1: no fx lock',
  );
  expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
  expect(alertOps).toHaveBeenCalledTimes(1);
});

test('a notice naming only our reference looks the row up once, by it', async () => {
  const h = harness([[row()]]);
  await handleWithdrawalCallback(
    h.scope,
    notice({ find: { merchantTransactionId: 'PC-1' } }),
  );
  expect(h.packs.listGatewayWithdrawals.mock.calls).toEqual([
    [{ merchant_transaction_id: 'PC-1', gateway: 'tgpay' }, { take: 1 }],
  ]);
  expect(applyWithdrawalOutcome).toHaveBeenCalledTimes(1);
});
