jest.mock('../tgpay-client', () => {
  const actual = jest.requireActual('../tgpay-client');
  return {
    ...actual,
    createPayment: jest.fn(),
    createPayout: jest.fn(),
    queryPayment: jest.fn(),
  };
});

import * as tgpay from '../tgpay-client';
import {
  checkBalance,
  gatewayConfigFromEnv,
  getDepositDetail,
  getSupportedBanks,
  paymentGateway,
  submitDeposit,
  submitWithdrawal,
  tgpayCheckoutBase,
} from '../gateway';
import { classifyRequeryError } from '../globepay-reconcile';

const tgpayConfig: tgpay.TgpayConfig = {
  kind: 'tgpay',
  baseUrl: 'https://sandbox-api.tgpay365.test/api/v2',
  publicKey: 'pk',
  secretKey: 'sk',
  currencyCode: 'MYR',
};

const depositInput = {
  merchantTransactionId: 'PC-1',
  merchantClientId: 'cus_1',
  amount: 50,
  notifyUrl: 'https://us/notify',
  returnUrl: 'https://us/return',
  ipAddress: '1.2.3.4',
  paymentMethodCode: 'OB',
  customer: { name: 'A', email: 'a@x.test', phoneNumber: '0123456789' },
};

afterEach(() => jest.clearAllMocks());

describe('the switch', () => {
  it('defaults to TGPay, and only an exact registered id changes that', () => {
    expect(paymentGateway({})).toBe('tgpay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'tgpay' })).toBe('tgpay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'TGPAY' })).toBe('tgpay');
  });

  it('reads the matching config family', () => {
    const cfg = gatewayConfigFromEnv({
      PAYMENT_GATEWAY: 'tgpay',
      TGPAY_API_BASE: 'https://x/api/v2',
      TGPAY_PUBLIC_KEY: 'pk',
      TGPAY_SECRET_KEY: 'sk',
    } as NodeJS.ProcessEnv);
    expect('kind' in cfg && cfg.kind).toBe('tgpay');
  });
});

describe('TGPay deposits', () => {
  it('maps OB→FPX, BQR→EWALLET and turns a relative checkout link absolute', async () => {
    (tgpay.createPayment as jest.Mock).mockResolvedValue({
      checkoutLink: '/checkout?order=abc123',
      order: 'abc123',
    });
    const r = await submitDeposit(depositInput, tgpayConfig);
    expect((tgpay.createPayment as jest.Mock).mock.calls[0][0]).toMatchObject({
      merchantRefNum: 'PC-1',
      paymentMethod: 'FPX',
      redirectUrl: 'https://us/return',
      customer: depositInput.customer,
      additionalData: 'Customer cus_1',
    });
    expect(r.url).toBe(
      'https://sandbox-checkout.tgpay365.test/checkout?order=abc123',
    );
    expect(r.transactionId).toBe('abc123');

    await submitDeposit(
      { ...depositInput, paymentMethodCode: 'BQR' },
      tgpayConfig,
    );
    expect(
      (tgpay.createPayment as jest.Mock).mock.calls[1][0].paymentMethod,
    ).toBe('EWALLET');
  });

  it('refuses DN (no hosted rail) and a missing contact as DEFINITE, before any HTTP', async () => {
    const dn = await submitDeposit(
      { ...depositInput, paymentMethodCode: 'DN' },
      tgpayConfig,
    ).catch((e: unknown) => e);
    expect((dn as tgpay.TgpayError).definite).toBe(true);
    const noContact = await submitDeposit(
      { ...depositInput, customer: undefined },
      tgpayConfig,
    ).catch((e: unknown) => e);
    expect((noContact as tgpay.TgpayError).definite).toBe(true);
    expect(tgpay.createPayment).not.toHaveBeenCalled();
  });

  it('TGPAY_CHECKOUT_BASE overrides the derived host', () => {
    expect(tgpayCheckoutBase(tgpayConfig, {})).toBe(
      'https://sandbox-checkout.tgpay365.test',
    );
    expect(
      tgpayCheckoutBase({ baseUrl: 'https://api.tgpay365.com/api/v2' }, {}),
    ).toBe('https://checkout.tgpay365.com');
    expect(
      tgpayCheckoutBase(tgpayConfig, {
        TGPAY_CHECKOUT_BASE: 'https://pay.example/',
      }),
    ).toBe('https://pay.example');
  });

  it('requery maps their string status onto the settlement state', async () => {
    (tgpay.queryPayment as jest.Mock).mockResolvedValue({
      order: 'abc',
      amount: 50,
      fee: 0.6,
      amountAfterFee: 49.4,
      status: 'APPROVED',
      paymentMethod: 'FPX',
    });
    const d = await getDepositDetail('PC-1', tgpayConfig);
    expect(d.state).toBe('success');
    expect(d.amount).toBe(50);
    expect(d.netAmount).toBe(49.4);
    expect(d.statusId).toBeNull();
    expect(d.transactionId).toBe('abc');
  });

  it('a TGPay 404 classifies as not-found for the sweep; a 400 stays ambiguous', () => {
    expect(
      classifyRequeryError(
        new tgpay.TgpayError('x', [tgpay.TGPAY_NOT_FOUND], 404, true),
      ),
    ).toEqual({ kind: 'not-found' });
    expect(
      classifyRequeryError(new tgpay.TgpayError('x', [], 400, true)),
    ).toEqual({
      kind: 'ambiguous',
    });
  });
});

describe('TGPay payouts', () => {
  const wd = {
    merchantTransactionId: 'PC-w1',
    merchantClientId: 'cus_1',
    amount: 100,
    destinationBankCode: 'DUMMYBANKVERIFIED',
    destinationAccountNumber: '543478924652',
    destinationAccountHolderName: 'Michael Yap',
    notifyUrl: 'https://us/wd',
    returnUrl: 'https://us/verify',
    ipAddress: '1.2.3.4',
    email: 'a@x.test',
  };

  it('sends the bankCode/bankName PAIR from the table and the recipient email', async () => {
    (tgpay.createPayout as jest.Mock).mockResolvedValue({
      transactionRefNum: 'tx-9',
    });
    const r = await submitWithdrawal(wd, tgpayConfig);
    expect((tgpay.createPayout as jest.Mock).mock.calls[0][0]).toEqual({
      merchantRefNum: 'PC-w1',
      amount: 100,
      email: 'a@x.test',
      userName: 'Michael Yap',
      bankAccNumber: '543478924652',
      bankCode: 'DUMMYBANKVERIFIED',
      bankName: 'Dummy Bank Verified',
      notifyUrl: 'https://us/wd',
    });
    expect(r.transactionId).toBe('tx-9');
  });

  it('pays a bank saved under GlobePay through TGPay after a switch (legacy code → SWIFT pair)', async () => {
    (tgpay.createPayout as jest.Mock).mockResolvedValue({
      transactionRefNum: 'tx-10',
    });
    await submitWithdrawal(
      { ...wd, destinationBankCode: 'MYMB2U' },
      tgpayConfig,
    );
    expect((tgpay.createPayout as jest.Mock).mock.calls[0][0]).toMatchObject({
      bankCode: 'MBBEMYKL',
      bankName: 'Maybank / Malayan Banking Berhad',
    });
  });
});

describe('TGPay balance', () => {
  it('maps pay-in to current and the payout wallet to available', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 1,
          data: { balance: 7, currency: { code: 'MYR', name: 'x' } },
        }),
    })) as unknown as typeof fetch;
    const b = await checkBalance(tgpayConfig);
    expect(b).toMatchObject({
      currentBalance: 7,
      availableBalance: 7,
      t1Balance: 0,
    });
    expect(b.merchantCode).not.toContain('pk');
  });
});
