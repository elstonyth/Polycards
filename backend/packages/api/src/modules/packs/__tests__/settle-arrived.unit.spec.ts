jest.mock('../gateway', () => {
  const actual = jest.requireActual('../gateway');
  return {
    ...actual,
    getDepositDetail: jest.fn(),
    rowGatewayConfigs: jest.fn(() => () => ({ kind: 'gp365' })),
  };
});
jest.mock('../gateway-deposit', () => ({
  applyDepositOutcome: jest.fn(),
}));

import { getDepositDetail } from '../gateway';
import { applyDepositOutcome } from '../gateway-deposit';
import {
  canSettleArrived,
  quoteArrivedDeposit,
  settleArrivedDeposit,
} from '../settle-arrived';

// A 50 USDT order locked at 4.179 (RM 208.95), held because 40 arrived.
const HELD = {
  id: 'gwd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-held',
  gateway_transaction_id: 'D1',
  amount_requested: 208.95,
  payment_method_code: 'UTRC',
  status: 'pending',
  gateway: 'gp365',
  currency: 'USDT',
  gateway_amount: 50,
  fx_mid: 4.2,
  fx_markup: 0.021,
};
const PAID_40 = {
  state: 'success',
  statusId: 6,
  amount: 167.16, // 40 x the locked RM 208.95 / 50
  reportedAmount: 40,
  netAmount: 164.65,
  bankReferenceNo: null,
  uniqueReferenceNo: null,
};

const listGatewayDeposits = jest.fn();
const createAdminActionAudits = jest.fn();
const scope = {
  resolve: () => ({ listGatewayDeposits, createAdminActionAudits }),
} as never;
const detail = getDepositDetail as jest.Mock;
const apply = applyDepositOutcome as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  listGatewayDeposits.mockResolvedValue([HELD]);
  detail.mockResolvedValue(PAID_40);
  apply.mockResolvedValue({ applied: true, replayed: false });
  createAdminActionAudits.mockResolvedValue([]);
});

const settle = (
  over: Partial<Parameters<typeof settleArrivedDeposit>[1]> = {},
) =>
  settleArrivedDeposit(scope, {
    depositId: 'gwd_1',
    expectedCredit: 167.16,
    adminId: 'user_1',
    reason: 'customer sent 40 from an exchange',
    ...over,
  });

describe('canSettleArrived', () => {
  it('is a held row on a rail that credits what arrived', () => {
    expect(canSettleArrived(HELD)).toBe(true);
    expect(canSettleArrived({ ...HELD, status: 'expired' })).toBe(true);
    expect(canSettleArrived({ ...HELD, status: 'settled' })).toBe(false);
    expect(canSettleArrived({ ...HELD, gateway: 'a3pay' })).toBe(false);
    expect(canSettleArrived({ ...HELD, gateway: 'globepay' })).toBe(false);
  });
});

describe('quoteArrivedDeposit', () => {
  it("quotes what arrived at the row's locked rate, live from the gateway", async () => {
    expect(await quoteArrivedDeposit(scope, 'gwd_1')).toEqual({
      depositId: 'gwd_1',
      merchantTransactionId: 'PC-held',
      customerId: 'cus_1',
      currency: 'USDT',
      ordered: 50,
      arrived: 40,
      requested: 208.95,
      credit: 167.16,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('settleArrivedDeposit', () => {
  it('records the decision, then credits through the shared requery path', async () => {
    const result = await settle();
    expect(result).toMatchObject({ kind: 'settled', replayed: false });
    expect(createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        admin_id: 'user_1',
        entity_type: 'gateway_deposit',
        entity_id: 'gwd_1',
        action: 'settle_deposit',
        reason: 'customer sent 40 from an exchange',
        after: expect.objectContaining({ arrived: 40, credit: 167.16 }),
      }),
    ]);
    expect(apply).toHaveBeenCalledWith(
      scope,
      HELD,
      expect.objectContaining({
        state: 'settled',
        source: 'requery',
        amount: 167.16,
        gatewayRef: 'D1',
      }),
    );
    // Audit strictly before the money.
    expect(createAdminActionAudits.mock.invocationCallOrder[0]).toBeLessThan(
      apply.mock.invocationCallOrder[0],
    );
  });

  it('credits nothing when the audit write fails', async () => {
    createAdminActionAudits.mockRejectedValue(new Error('check constraint'));
    await expect(settle()).rejects.toThrow(/check constraint/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns the new quote, writing nothing, when the record moved since the operator looked', async () => {
    const result = await settle({ expectedCredit: 208.95 });
    expect(result).toMatchObject({
      kind: 'changed',
      quote: { credit: 167.16 },
    });
    expect(createAdminActionAudits).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('accepts a held row the sweep had expired', async () => {
    listGatewayDeposits.mockResolvedValue([{ ...HELD, status: 'expired' }]);
    await expect(settle()).resolves.toMatchObject({ kind: 'settled' });
  });

  it.each([
    ['settled', /settled; only a held deposit/],
    ['failed', /failed; only a held deposit/],
  ])('refuses a %s row', async (status, message) => {
    listGatewayDeposits.mockResolvedValue([{ ...HELD, status }]);
    await expect(settle()).rejects.toThrow(message);
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses an exact-amount gateway (A3Pay) and RM rows', async () => {
    for (const gateway of ['a3pay', 'tgpay']) {
      listGatewayDeposits.mockResolvedValue([{ ...HELD, gateway }]);
      await expect(settle()).rejects.toThrow(/Only USDT deposits/);
    }
    expect(detail).not.toHaveBeenCalled();
  });

  it('refuses when the gateway does not report it paid', async () => {
    detail.mockResolvedValue({ ...PAID_40, state: 'pending' });
    await expect(settle()).rejects.toThrow(
      /does not report this deposit as paid/,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses an unreadable or non-positive amount, and anything over the ceiling', async () => {
    detail.mockResolvedValue({ ...PAID_40, amount: Number.NaN });
    await expect(settle()).rejects.toThrow(/no payable amount/);
    detail.mockResolvedValue({ ...PAID_40, amount: 10000.01 });
    await expect(settle({ expectedCredit: 10000.01 })).rejects.toThrow(
      /top-up ceiling/,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('never settles on a gateway answer it could not read', async () => {
    detail.mockRejectedValue(new Error('HTTP 502'));
    await expect(settle()).rejects.toThrow(/Could not read GlobePay365/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('404s an unknown deposit', async () => {
    listGatewayDeposits.mockResolvedValue([]);
    await expect(settle()).rejects.toThrow(/No such deposit/);
  });
});
