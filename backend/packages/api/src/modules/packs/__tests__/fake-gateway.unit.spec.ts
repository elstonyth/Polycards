import { GatewayError } from '../gateway-types';
import { fakeGateway, type FakeConfig } from '../fake-gateway';
import {
  checkBalance,
  GATEWAY_IDS,
  GATEWAYS,
  gatewayConfigFor,
  getDepositDetail,
  getSupportedBanks,
  getWithdrawalDetail,
  isPaymentGateway,
  submitDeposit,
  submitWithdrawal,
} from '../gateway';

// The fake gateway is the second adapter behind the seam in gateway.ts. It
// exists so a spec can drive the money paths through the SAME dispatch the
// production code uses (config kind -> adapter) instead of replacing the
// module with jest.mock. What this file owns: the scripting surface those
// specs depend on, and the guard that keeps 'fake' unreachable off `test`.

const config: FakeConfig = { kind: 'fake' };

const depositInput = {
  merchantTransactionId: 'PC-1',
  merchantClientId: 'cus_1',
  amount: 50,
  notifyUrl: 'https://us/notify',
  returnUrl: 'https://us/return',
  ipAddress: '1.2.3.4',
  paymentMethodCode: 'OB',
};

const withdrawalInput = {
  merchantTransactionId: 'PW-1',
  merchantClientId: 'cus_1',
  amount: 100,
  destinationBankCode: 'MBBEMYKL',
  destinationAccountNumber: '1234567890',
  destinationAccountHolderName: 'AHMAD BIN ALI',
  notifyUrl: 'https://us/notify-wd',
  returnUrl: 'https://us/payout-verify',
  ipAddress: '1.2.3.4',
  email: 'cus1@x.test',
};

beforeEach(() => {
  fakeGateway.reset();
});

describe('the fake adapter, through the seam', () => {
  it('is the adapter the seam picks for a fake config', async () => {
    const r = await submitDeposit(depositInput, config);
    // Dispatched by kind, not by import: the module-level functions are what
    // the orchestration calls.
    expect(fakeGateway.calls.deposits).toEqual([depositInput]);
    expect(r.transactionId).toMatch(/^FAKE-D-/);
    expect(r.url).toContain('PC-1');
    expect(r.depositActualAmount).toBe(50);
  });

  it('records every submitted payout in order', async () => {
    await submitWithdrawal(withdrawalInput, config);
    await submitWithdrawal(
      { ...withdrawalInput, merchantTransactionId: 'PW-2' },
      config,
    );
    expect(
      fakeGateway.calls.withdrawals.map((w) => w.merchantTransactionId),
    ).toEqual(['PW-1', 'PW-2']);
  });

  it('answers a requery with a well-formed settled detail', async () => {
    const d = await getDepositDetail('PC-1', config);
    expect(d).toMatchObject({
      merchantTransactionId: 'PC-1',
      state: 'success',
      statusId: null,
    });
    const w = await getWithdrawalDetail('PW-1', config);
    expect(w.state).toBe('success');
    expect(fakeGateway.calls.depositDetails).toEqual(['PC-1']);
    expect(fakeGateway.calls.withdrawalDetails).toEqual(['PW-1']);
  });

  it('reports a wallet and a bank list without any network', async () => {
    const b = await checkBalance(config);
    expect(b.currencyCode).toBe('MYR');
    expect(b.availableBalance).toBeGreaterThan(0);
    expect(fakeGateway.calls.balances).toEqual([config]);
    expect((await getSupportedBanks(config)).length).toBeGreaterThan(0);
  });

  it('hands a scripted result back VERBATIM — a field the script omits stays missing', async () => {
    fakeGateway.script({
      getWithdrawalDetail: { state: 'failed', statusId: 5 },
    });
    const w = await getWithdrawalDetail('PW-1', config);
    expect(w.state).toBe('failed');
    expect(w.statusId).toBe(5);
    // NOT filled in from the canonical result: callers branch on a missing
    // amount, so merging would change what the subject under test sees.
    expect(w.amount).toBeUndefined();
  });

  it('throws the scripted error object itself, definite flag and all', async () => {
    const refusal = new GatewayError(
      'Insufficient float',
      ['PMT10013'],
      400,
      true,
    );
    fakeGateway.script({ submitWithdrawal: refusal });
    await expect(submitWithdrawal(withdrawalInput, config)).rejects.toBe(
      refusal,
    );
    await expect(
      submitWithdrawal(withdrawalInput, config),
    ).rejects.toMatchObject({ definite: true, httpStatus: 400 });
    // An ambiguous failure is a plain Error — the branch that must NOT refund.
    fakeGateway.script({ submitWithdrawal: new Error('socket hang up') });
    await expect(submitWithdrawal(withdrawalInput, config)).rejects.toThrow(
      'socket hang up',
    );
    // Refused calls are still recorded: a spec asserts the seam was reached.
    expect(fakeGateway.calls.withdrawals).toHaveLength(3);
  });

  it('runs a scripted function, so a spec can pin ordering', async () => {
    const order: string[] = [];
    fakeGateway.script({
      submitDeposit: () => {
        order.push('gateway');
        return { transactionId: 'D1', url: 'u', depositActualAmount: 50 };
      },
    });
    const r = await submitDeposit(depositInput, config);
    expect(order).toEqual(['gateway']);
    expect(r.transactionId).toBe('D1');
  });

  it('scripting one operation leaves the others alone', async () => {
    fakeGateway.script({ submitDeposit: new Error('down') });
    fakeGateway.script({ checkBalance: new Error('403 not allowed') });
    await expect(submitDeposit(depositInput, config)).rejects.toThrow('down');
    await expect(checkBalance(config)).rejects.toThrow('403');
  });

  it('reset() clears the script AND the call log', async () => {
    fakeGateway.script({ submitWithdrawal: new Error('down') });
    await expect(submitWithdrawal(withdrawalInput, config)).rejects.toThrow();
    fakeGateway.reset();
    await expect(
      submitWithdrawal(withdrawalInput, config),
    ).resolves.toMatchObject({
      transactionId: expect.stringMatching(/^FAKE-W-/),
    });
    expect(fakeGateway.calls.withdrawals).toHaveLength(1);
    expect(fakeGateway.calls.deposits).toEqual([]);
  });
});

// The whole reason 'fake' can live in the PaymentGateway union: it is
// unreachable in a real deploy. A selectable fake gateway would mint credits
// for free, so the guard is tested from both sides.
describe('the production guard', () => {
  const NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV;
  });

  it("'fake' is a payment gateway only under NODE_ENV=test", () => {
    process.env.NODE_ENV = 'test';
    expect(isPaymentGateway('fake')).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(isPaymentGateway('fake')).toBe(false);
    // The real gateway is unaffected by the env either way.
    expect(isPaymentGateway('tgpay')).toBe(true);
  });

  it('gatewayConfigFor("fake") throws outside test', () => {
    process.env.NODE_ENV = 'test';
    expect(gatewayConfigFor('fake')).toEqual({ kind: 'fake' });
    process.env.NODE_ENV = 'production';
    expect(() => gatewayConfigFor('fake')).toThrow(/fake/);
  });

  it('never reports itself configured outside test', () => {
    process.env.NODE_ENV = 'test';
    expect(GATEWAYS.fake.configured({})).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(GATEWAYS.fake.configured({})).toBe(false);
    // Belt and braces: even reached directly, it refuses to make a config.
    expect(() =>
      GATEWAYS.fake.configFromEnv({} as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('is never offered to the operator, in any environment', () => {
    // The admin switch lists GATEWAY_IDS and refuses anything isPaymentGateway
    // rejects; the fake is in neither list a deploy can reach.
    expect(GATEWAY_IDS).not.toContain('fake');
  });
});
