/**
 * The Withdrawal lifecycle's interface: each status transition is ONE
 * conditional claim, and its answer (won / lost) comes back unchanged. The
 * claim's own SQL is proven against a real Postgres in
 * withdrawal-claim.integration.spec.ts.
 */
import {
  claimHeldWithdrawal,
  failWithdrawal,
  settleWithdrawal,
  stampPendingWithdrawal,
  stampWithdrawalAudit,
} from '../withdrawal-lifecycle';

const packsWith = (claimed: boolean) => ({
  claimWithdrawalStatus: jest.fn().mockResolvedValue(claimed),
  claimWithdrawalAgainstDebit: jest
    .fn()
    .mockResolvedValue({ debited: true, claimed }),
  updateGatewayWithdrawals: jest.fn().mockResolvedValue([]),
});

describe.each([true, false])('claim %s', (won) => {
  test('settleWithdrawal claims pending -> settled with the facts', async () => {
    const packs = packsWith(won);
    const settledAt = new Date('2026-11-17T00:00:00Z');
    await expect(
      settleWithdrawal(packs, 'wd_1', {
        settledAt,
        gatewayTransactionId: 'W1',
        gatewayStatus: 3,
        bankReferenceNo: null,
        uniqueReferenceNo: undefined,
        amountSettled: 10,
        netAmount: undefined,
      }),
    ).resolves.toBe(won);
    expect(packs.claimWithdrawalStatus).toHaveBeenCalledTimes(1);
    expect(packs.claimWithdrawalStatus).toHaveBeenCalledWith({
      id: 'wd_1',
      from: ['pending'],
      to: 'settled',
      set: {
        settled_at: settledAt,
        gateway_transaction_id: 'W1',
        gateway_status: 3,
        bank_reference_no: null,
      },
      money: { amount_settled: 10 },
    });
    expect(packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
  });

  test('failWithdrawal claims from the given statuses -> failed', async () => {
    const packs = packsWith(won);
    await expect(
      failWithdrawal(packs, 'wd_1', {
        from: ['pending', 'held'],
        gatewayStatus: null,
        failureReason: 'x'.repeat(500),
      }),
    ).resolves.toBe(won);
    expect(packs.claimWithdrawalStatus).toHaveBeenCalledWith({
      id: 'wd_1',
      from: ['pending', 'held'],
      to: 'failed',
      set: { gateway_status: null, failure_reason: 'x'.repeat(400) },
    });
    expect(packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
  });

  test('claimHeldWithdrawal answers the locked claim unchanged', async () => {
    const packs = packsWith(won);
    const input = {
      id: 'wd_1',
      customerId: 'cus_1',
      debitReference: 'wd:abc',
      from: ['held'] as const,
      to: 'pending' as const,
    };
    await expect(claimHeldWithdrawal(packs, input)).resolves.toEqual({
      debited: true,
      claimed: won,
    });
    expect(packs.claimWithdrawalAgainstDebit).toHaveBeenCalledWith(input);
  });
});

test('failWithdrawal with nothing to say writes status alone', async () => {
  const packs = packsWith(true);
  await failWithdrawal(packs, 'wd_1', { from: ['pending'] });
  expect(packs.claimWithdrawalStatus).toHaveBeenCalledWith({
    id: 'wd_1',
    from: ['pending'],
    to: 'failed',
    set: {},
  });
});

test('settleWithdrawal never writes an empty gateway id', async () => {
  const packs = packsWith(true);
  await settleWithdrawal(packs, 'wd_1', {
    settledAt: new Date(),
    gatewayTransactionId: '',
  });
  const [[claim]] = packs.claimWithdrawalStatus.mock.calls;
  expect(claim.set).not.toHaveProperty('gateway_transaction_id');
});

test('stampPendingWithdrawal is scoped to a pending row and never moves status', async () => {
  const packs = packsWith(true);
  await stampPendingWithdrawal(packs, 'wd_1', { gateway_transaction_id: 'W1' });
  expect(packs.updateGatewayWithdrawals).toHaveBeenCalledWith({
    selector: { id: 'wd_1', status: 'pending' },
    data: { gateway_transaction_id: 'W1' },
  });
  expect(packs.claimWithdrawalStatus).not.toHaveBeenCalled();
});

test('stampWithdrawalAudit writes the audit fields by id', async () => {
  const packs = packsWith(true);
  const auditedAt = new Date();
  await stampWithdrawalAudit(packs, 'wd_1', {
    audited_at: auditedAt,
    audit_note: null,
    net_amount: 9.5,
  });
  expect(packs.updateGatewayWithdrawals).toHaveBeenCalledWith({
    id: 'wd_1',
    audited_at: auditedAt,
    audit_note: null,
    net_amount: 9.5,
  });
});
