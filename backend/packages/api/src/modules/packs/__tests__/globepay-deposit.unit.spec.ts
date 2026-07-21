import {
  GLOBEPAY_DEFAULT_METHOD,
  globepayEnabled,
  newMerchantTransactionId,
  startGlobePayDeposit,
} from '../globepay-deposit';

// startGlobePayDeposit talks to the gateway through globepay-client; stub that
// seam so these tests cover the state machine (row before call, row closed on
// failure, id stamped on success) rather than the HTTP layer, which has its own
// specs.
jest.mock('../globepay-client', () => {
  const actual = jest.requireActual('../globepay-client');
  return {
    ...actual,
    globepayConfigFromEnv: jest.fn(() => ({
      baseUrl: 'https://mapi.example.test',
      merchantCode: 'Testpolycard',
      aesKey: 'test-aes-key',
      privateKey: 'priv',
      publicKey: 'pub',
      currencyCode: 'MYR',
    })),
    submitDeposit: jest.fn(),
  };
});

import { GlobePayError, submitDeposit } from '../globepay-client';

const submitMock = submitDeposit as jest.Mock;

function harness() {
  const packs = {
    createGlobePayDeposits: jest.fn().mockResolvedValue([{ id: 'gpd_1' }]),
    updateGlobePayDeposits: jest.fn().mockResolvedValue(undefined),
  };
  return {
    packs,
    scope: { resolve: () => packs } as never,
  };
}

const input = {
  customerId: 'cus_1',
  amount: 50,
  ipAddress: '1.2.3.4',
};

const start = (
  h: ReturnType<typeof harness>,
  over: Record<string, unknown> = {},
) =>
  startGlobePayDeposit(
    h.scope,
    { ...input, ...over },
    'https://us/notify',
    'https://us/return',
  );

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({
    transactionId: 'D2026072112415767',
    url: 'https://cashier/x',
    depositActualAmount: 50,
  });
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
});

describe('globepayEnabled', () => {
  it('is off unless explicitly enabled AND configured', () => {
    expect(globepayEnabled({})).toBe(false);
    expect(globepayEnabled({ GLOBEPAY_ENABLED: 'true' })).toBe(false);
    expect(globepayEnabled({ GLOBEPAY_MERCHANT_CODE: 'M' })).toBe(false);
    expect(
      globepayEnabled({
        GLOBEPAY_ENABLED: 'true',
        GLOBEPAY_MERCHANT_CODE: 'M',
      }),
    ).toBe(true);
  });
});

describe('newMerchantTransactionId', () => {
  it('is opaque and unique — it is shown in THEIR back office', () => {
    const a = newMerchantTransactionId();
    const b = newMerchantTransactionId();
    expect(a).not.toBe(b);
    expect(a.startsWith('PC-')).toBe(true);
    // No customer id smuggled in: the row is what maps it back.
    expect(a).not.toMatch(/cus_/);
  });
});

describe('startGlobePayDeposit', () => {
  it('writes the pending row BEFORE calling the gateway', async () => {
    const h = harness();
    const order: string[] = [];
    h.packs.createGlobePayDeposits.mockImplementation(async () => {
      order.push('row');
      return [{ id: 'gpd_1' }];
    });
    submitMock.mockImplementation(async () => {
      order.push('gateway');
      return { transactionId: 'D1', url: 'u', depositActualAmount: 50 };
    });

    await start(h);
    // Reversed, a callback could arrive for a reference we have no record of.
    expect(order).toEqual(['row', 'gateway']);
  });

  it('stamps their transaction id on the row after a successful submit', async () => {
    const h = harness();
    const result = await start(h);
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      gateway_transaction_id: 'D2026072112415767',
    });
    expect(result.url).toBe('https://cashier/x');
    expect(result.merchantTransactionId).toBe(
      h.packs.createGlobePayDeposits.mock.calls[0][0][0]
        .merchant_transaction_id,
    );
  });

  it('defaults to the provisioned method and passes the CUSTOMER ip', async () => {
    const h = harness();
    await start(h);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodCode: GLOBEPAY_DEFAULT_METHOD,
        ipAddress: '1.2.3.4',
        notifyUrl: 'https://us/notify',
      }),
      expect.anything(),
    );
  });

  it('closes the row out when the gateway refuses, so it never lingers pending', async () => {
    const h = harness();
    submitMock.mockRejectedValue(new GlobePayError('nope', ['PMT10005'], 200));
    await expect(start(h)).rejects.toThrow(/could not start your top-up/i);
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      status: 'failed',
    });
  });

  it('rejects an invalid amount before touching the gateway', async () => {
    const h = harness();
    await expect(start(h, { amount: -5 })).rejects.toThrow(
      /greater than zero/i,
    );
    expect(submitMock).not.toHaveBeenCalled();
    expect(h.packs.createGlobePayDeposits).not.toHaveBeenCalled();
  });

  it('rejects a payment method outside the MYR allow-list', async () => {
    const h = harness();
    // UPI is an INR method — asking for it here would depend on gateway-side
    // behaviour we cannot see.
    await expect(start(h, { paymentMethodCode: 'UPI' })).rejects.toThrow(
      /unsupported payment method/i,
    );
    expect(submitMock).not.toHaveBeenCalled();
    expect(h.packs.createGlobePayDeposits).not.toHaveBeenCalled();
  });

  it('accepts every documented MYR method', async () => {
    for (const method of ['FPX', 'DN', 'BQR', 'OB']) {
      const h = harness();
      await expect(start(h, { paymentMethodCode: method })).resolves.toBeTruthy();
    }
  });

  it('refuses to run when the gateway is not enabled', async () => {
    process.env.GLOBEPAY_ENABLED = 'false';
    const h = harness();
    await expect(start(h)).rejects.toThrow(/temporarily unavailable/i);
    expect(submitMock).not.toHaveBeenCalled();
  });
});
