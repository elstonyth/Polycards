import { Modules } from '@medusajs/framework/utils';
import { setActiveGateway } from '../gateway';
import { PAYER_BANK_REQUIRED_MESSAGE, startDeposit } from '../gateway-deposit';

// GMpay declares the paying account (holder, bank, number) on every pay-in.
// startDeposit must refuse a top-up without one BEFORE any row, and pass a
// saved account's bank (in GMpay's code) and number through when it has one.

// GMpay's bank table is pinned here, whatever banks.ts holds once their live
// list is in: only DBS has a code, so the happy path runs and every other
// bank stays unserved.
jest.mock('../banks', () => {
  const actual = jest.requireActual('../banks');
  return {
    ...actual,
    gatewayBankCode: (
      alias: string,
      gateway: string,
      env?: Record<string, string>,
    ) =>
      gateway === 'gmpay'
        ? alias === 'DBSSSGSG'
          ? { code: 'DBS', name: 'DBS Bank' }
          : null
        : actual.gatewayBankCode(alias, gateway, env),
  };
});

const FX_ROW = {
  pair: 'SGD_MYR',
  rate: 3.2,
  fee_enabled: true,
  deposit_fee_percent: 3.125,
  payout_fee_percent: 3.125,
  manual_override: false,
  manual_rate: null,
  fetched_at: new Date(),
};

const ORIGINAL = { ...process.env };
const originalFetch = global.fetch;
let sent: Record<string, unknown>[];

beforeEach(() => {
  process.env = {
    ...ORIGINAL,
    GATEWAY_ENABLED: 'true',
    GMPAY_ENABLED: 'true',
    GMPAY_API_BASE: 'https://xapi.example.test/v3',
    GMPAY_CLIENT_ID: 'client-1',
    GMPAY_SECRET_KEY: 'secret',
    PAYMENT_CALLBACK_BASE: 'https://us.test',
  };
  setActiveGateway('tgpay');
  sent = [];
  global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    sent.push({ url: String(url), ...JSON.parse(init?.body ?? '{}') });
    return new Response(
      JSON.stringify({
        status_code: 0,
        tran_token: 'tok-1',
        tran_unique: 'ignored',
        tran_amount: 50,
        redirect_to: 'https://cashier.gmpay.test/tok-1',
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIGINAL;
  global.fetch = originalFetch;
  setActiveGateway(null);
});

function scopeFor(packs: Record<string, unknown>) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const others: Record<string, unknown> = {
    logger,
    [Modules.NOTIFICATION]: { createNotifications: jest.fn() },
  };
  return { resolve: (k: string) => others[k] ?? packs } as never;
}

function depositPacks() {
  return {
    listFxRates: jest.fn().mockResolvedValue([FX_ROW]),
    createDepositCapped: jest.fn().mockResolvedValue({ id: 'gpd_1' }),
    updateGatewayDeposits: jest.fn().mockResolvedValue(undefined),
  };
}

const pay = (
  packs: ReturnType<typeof depositPacks>,
  payerBank?: { bankCode: string; accountNumber: string },
) =>
  startDeposit(
    scopeFor(packs),
    {
      customerId: 'cus_1',
      amount: 50,
      ipAddress: '1.2.3.4',
      gateway: 'gmpay',
      paymentMethodCode: 'BQR',
      payerName: 'TAN AH KOW',
      payerBank,
    },
    'https://us/notify',
    'https://us/return',
  );

describe('a GMpay payout refusal on a 5xx', () => {
  it('never carries the empty-wallet hint', async () => {
    const { submitPayout, GMPAY_PAYOUT_FLOAT_EMPTY, GmpayError } =
      jest.requireActual('../gmpay-client');
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status_code: -1, status_msg: 'insufficient balance' }),
        { status: 502 },
      ),
    );
    const error = await submitPayout(
      {
        merchantTransactionId: 'PC-1',
        customerId: 'cus_1',
        amount: 50,
        bankCode: 'DBS',
        accountName: 'TAN AH KOW',
        accountNumber: '0123456789',
        callbackUrl: 'https://us/notify',
      },
      {
        kind: 'gmpay',
        baseUrl: 'https://xapi.example.test/v3',
        clientId: 'client-1',
        secretKey: 'secret',
        currencyCode: 'SGD',
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmpayError);
    expect(error.has(GMPAY_PAYOUT_FLOAT_EMPTY)).toBe(false);
    expect(error.definite).toBe(false);
  });
});

describe('a GMpay top-up and the paying account', () => {
  it('without a saved account it refuses before any row or gateway call', async () => {
    const packs = depositPacks();
    await expect(pay(packs)).rejects.toThrow(PAYER_BANK_REQUIRED_MESSAGE);
    expect(packs.createDepositCapped).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a blank account number is no account', async () => {
    const packs = depositPacks();
    await expect(
      pay(packs, { bankCode: 'DBSSSGSG', accountNumber: '  ' }),
    ).rejects.toThrow(PAYER_BANK_REQUIRED_MESSAGE);
    expect(packs.createDepositCapped).not.toHaveBeenCalled();
  });

  it("declares the saved account in GMpay's bank code, with the holder and number", async () => {
    const packs = depositPacks();
    const result = await pay(packs, {
      bankCode: 'DBSSSGSG',
      accountNumber: '0123456789',
    });
    expect(result.url).toBe('https://cashier.gmpay.test/tok-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: 'https://xapi.example.test/v3/payin',
      cont_code: 'SGD_PAYNOW',
      tran_customer_bank_code: 'DBS',
      tran_customer_bank_holder_name: 'TAN AH KOW',
      tran_customer_bank_account: '0123456789',
      tran_amount: 50,
    });
  });

  it('a create that asks another sum keeps the token but withholds the cashier', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status_code: 0,
          tran_token: 'tok-9',
          tran_amount: 49,
          redirect_to: 'https://cashier.gmpay.test/tok-9',
        }),
        { status: 200 },
      ),
    );
    const packs = depositPacks();
    await expect(
      pay(packs, { bankCode: 'DBSSSGSG', accountNumber: '0123456789' }),
    ).rejects.toThrow(/temporarily unavailable on our side/);
    expect(packs.updateGatewayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      gateway_transaction_id: 'tok-9',
    });
  });

  it('a saved bank GMpay does not serve is refused by the adapter, and the row closes', async () => {
    const packs = depositPacks();
    await expect(
      pay(packs, { bankCode: 'OCBCSGSG', accountNumber: '0123456789' }),
    ).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpd_1', status: 'failed' }),
    );
  });
});
