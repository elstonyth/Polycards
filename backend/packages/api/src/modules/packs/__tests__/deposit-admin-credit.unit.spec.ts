import { Modules } from '@medusajs/framework/utils';
import type { FakeFacet, GatewayDeposits } from '../facets';
import { fakeGateway } from '../fake-gateway';
import { setActiveGateway } from '../gateway';
import { GatewayError } from '../gateway-types';
import { creditDepositByAdmin } from '../gateway-deposit';
import { topupIdempotencyReference } from '../topup';

// A customer paid and the row says failed or expired. A hand adjustment has no
// link to the deposit, so automation could credit the same payment again; this
// credit goes through the sweep's own anchor, so only one can ever land.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  fakeGateway.reset();
  setActiveGateway('fake');
  process.env.GATEWAY_ENABLED = 'true';
  process.env.PAYMENT_GATEWAY = 'fake';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const failedRow = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'T-1',
  amount_requested: '300',
  payment_method_code: 'FPX',
  status: 'failed',
  gateway: 'fake',
};

const paid = {
  state: 'success' as const,
  amount: 300,
  netAmount: 295,
  statusId: null,
  transactionId: 'T-1',
};

function harness(
  row: Record<string, unknown> | null = failedRow,
  ledger: { anchored?: unknown[]; hand?: unknown[] } = {},
  replayed = false,
) {
  const packs = {
    listGatewayDeposits: jest.fn(async () => (row ? [row] : [])),
    listCreditTransactions: jest.fn(
      async (f: { source_transaction_id?: string }) =>
        f.source_transaction_id ? (ledger.anchored ?? []) : (ledger.hand ?? []),
    ),
    topUpCreditsWithLedger: jest.fn(async () => ({
      id: 'ct_1',
      amount: 300,
      balance: 300,
      replayed,
    })),
    claimDepositStatus: jest.fn(async () => true),
    createAdminActionAudits: jest.fn(async () => []),
    updateGatewayDeposits: jest.fn(async () => ({})),
  } satisfies FakeFacet<GatewayDeposits>;
  const others: Record<string, unknown> = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    [Modules.CUSTOMER]: {
      retrieveCustomer: async () => ({ email: 'payer@example.test' }),
    },
    [Modules.NOTIFICATION]: { createNotifications: jest.fn() },
  };
  const scope = {
    resolve: (k: string) => others[k] ?? packs,
  } as never;
  const credit = () =>
    creditDepositByAdmin(scope, {
      depositId: 'gpd_1',
      adminId: 'usr_admin_1',
      reason: 'Customer showed the bank slip',
    });
  return { packs, credit };
}

describe('creditDepositByAdmin', () => {
  it('credits on the sweep\'s own anchor and closes the row', async () => {
    fakeGateway.script({ getDepositDetail: paid });
    const h = harness();
    await expect(h.credit()).resolves.toEqual({
      credited: true,
      replayed: false,
    });
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 300,
        reason: 'topup',
        idempotencyReference: topupIdempotencyReference('cus_1', 'PC-1'),
      }),
    );
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpd_1', from: ['failed'], to: 'settled' }),
    );
  });

  it('records who did it and why', async () => {
    fakeGateway.script({ getDepositDetail: paid });
    const h = harness();
    await h.credit();
    expect(h.packs.createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        admin_id: 'usr_admin_1',
        entity_type: 'gateway_deposit',
        entity_id: 'gpd_1',
        reason: 'Customer showed the bank slip',
      }),
    ]);
  });

  // "Customer was not credited" must not sit beside a settled row until the
  // next hourly check: staff read it as money still owed.
  it('clears the finding it just answered', async () => {
    fakeGateway.script({ getDepositDetail: paid });
    const h = harness({
      ...failedRow,
      audit_note: 'customer paid and was not credited',
    });
    await h.credit();
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpd_1', audit_note: null }),
    );
  });

  // The anchor is what makes it safe: a credit already there is not paid again.
  it('a credit already on the anchor replays, and only heals the row', async () => {
    fakeGateway.script({ getDepositDetail: paid });
    const h = harness(failedRow, {}, true);
    await expect(h.credit()).resolves.toEqual({
      credited: true,
      replayed: true,
    });
    expect(h.packs.claimDepositStatus).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'pending'])('credits a %s row', async (status) => {
    fakeGateway.script({ getDepositDetail: paid });
    const h = harness({ ...failedRow, status });
    await h.credit();
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({ from: [status], to: 'settled' }),
    );
  });

  describe('refuses, moving no money', () => {
    const noMoney = (h: ReturnType<typeof harness>) => {
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.claimDepositStatus).not.toHaveBeenCalled();
      expect(h.packs.createAdminActionAudits).not.toHaveBeenCalled();
    };

    it('an unknown deposit', async () => {
      const h = harness(null);
      await expect(h.credit()).rejects.toThrow(/No such deposit/);
      noMoney(h);
    });

    it('a row already settled', async () => {
      fakeGateway.script({ getDepositDetail: paid });
      const h = harness({ ...failedRow, status: 'settled' });
      await expect(h.credit()).rejects.toThrow(/already settled/i);
      noMoney(h);
    });

    it.each(['pending', 'failed'] as const)(
      'when the gateway says %s',
      async (state) => {
        fakeGateway.script({
          getDepositDetail: { ...paid, state },
        });
        const h = harness();
        await expect(h.credit()).rejects.toThrow(/does not report .* paid/i);
        noMoney(h);
      },
    );

    it('when the gateway cannot be asked', async () => {
      fakeGateway.script({
        getDepositDetail: new GatewayError('their outage', [], 500),
      });
      const h = harness();
      await expect(h.credit()).rejects.toThrow(/could not be asked/i);
      noMoney(h);
    });

    // A short or over payment stays an engineer's call (2026-10-26).
    it('an amount that is not what the row asked for', async () => {
      fakeGateway.script({ getDepositDetail: { ...paid, amount: 299 } });
      const h = harness();
      await expect(h.credit()).rejects.toThrow(/not what the deposit asked/i);
      noMoney(h);
    });

    it('a deposit a hand adjustment already names', async () => {
      fakeGateway.script({ getDepositDetail: paid });
      const h = harness(failedRow, {
        hand: [{ reference: 'Credited by hand for PC-1' }],
      });
      await expect(h.credit()).rejects.toThrow(/hand adjustment/i);
      noMoney(h);
    });

    it('a gateway that is not configured', async () => {
      const h = harness({ ...failedRow, gateway: 'globepay' });
      await expect(h.credit()).rejects.toThrow(/not configured/i);
      noMoney(h);
    });
  });
});
