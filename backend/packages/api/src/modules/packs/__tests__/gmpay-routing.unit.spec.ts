import {
  GATEWAYS,
  getDepositDetail,
  getWithdrawalDetail,
  submitDeposit,
  submitWithdrawal,
  type GatewayConfig,
} from '../gateway';
import { regionalDepositGateway } from '../gateway-deposit';
import { regionalPayoutGateways } from '../gateway-withdrawal';
import { classifyRequeryError } from '../gateway-reconcile';
import { GmpayError, gmpaySign } from '../gmpay-client';
import { refundsWithoutLookup } from '../withdrawal-submit';
import { GatewayError } from '../gateway-types';
import { MY_BANKS, SG_BANKS, banksFor, gatewayBankCode } from '../banks';

const GMPAY_ENV = {
  GATEWAY_ENABLED: 'true',
  GATEWAY_WITHDRAWALS_ENABLED: 'true',
  GMPAY_ENABLED: 'true',
  GMPAY_API_BASE: 'https://xapi.example.test/v3',
  GMPAY_CLIENT_ID: 'client-1',
  GMPAY_SECRET_KEY: 'secret',
};

const CONFIG: GatewayConfig = {
  kind: 'gmpay',
  baseUrl: 'https://xapi.example.test/v3',
  clientId: 'client-1',
  secretKey: 'secret',
  currencyCode: 'SGD',
};

// S$100 locked against RM 319 (RM 3.19 per S$1).
const FX = { ledgerAmount: 319, gatewayAmount: 100, currency: 'SGD' };

afterEach(() => jest.restoreAllMocks());

function answer(body: Record<string, unknown>) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

describe('GMpay in the registry', () => {
  it('takes SGD top-ups only while switched on, and A3Pay stays closed', () => {
    expect(regionalDepositGateway('SGD', GMPAY_ENV)).toBe('gmpay');
    expect(
      regionalDepositGateway('SGD', { ...GMPAY_ENV, GMPAY_ENABLED: 'false' }),
    ).toBeNull();
    expect(regionalPayoutGateways(GMPAY_ENV)).toEqual(['gmpay']);
  });

  it('settles in SGD with its own hooks and no nudge', () => {
    expect(GATEWAYS.gmpay.currency).toBe('SGD');
    expect(GATEWAYS.gmpay.hooks).toEqual({
      deposit: '/hooks/gmpay/deposit',
      withdrawal: '/hooks/gmpay/withdrawal',
    });
    expect(GATEWAYS.gmpay.payinNudgeCents).toBe(0);
    expect(GATEWAYS.gmpay.depositMethods).toEqual(['BQR', 'OB']);
  });
});

describe('GMpay status checks', () => {
  it('asks by the token on the row and converts at the locked rate', async () => {
    const spy = answer({
      status_code: 0,
      tran_token: 'tok-1',
      tran_unique: 'PC-1',
      tran_amount: 100,
      tran_fee: 1.1,
      tran_status: 'completed',
    });
    const d = await getDepositDetail('PC-1', CONFIG, FX, 'tok-1');
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.tran_token).toBe('tok-1');
    expect(String(spy.mock.calls[0][0])).toBe(
      'https://xapi.example.test/v3/payinQuery',
    );
    expect(d.state).toBe('success');
    expect(d.reportedAmount).toBe(100);
    expect(d.amount).toBe(319);
  });

  it('a row without their token is unclear: the sweeps wait, never write off', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const error = await getDepositDetail('PC-1', CONFIG, FX, null).catch(
      (e: unknown) => e,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(classifyRequeryError(error).kind).toBe('ambiguous');
    const payout = await getWithdrawalDetail('PW-1', CONFIG, FX, '').catch(
      (e: unknown) => e,
    );
    expect(classifyRequeryError(payout).kind).toBe('ambiguous');
  });

  it("an answer for another reference is unclear, not that row's outcome", async () => {
    answer({
      status_code: 0,
      tran_token: 'tok-1',
      tran_unique: 'PC-OTHER',
      tran_amount: 100,
      tran_status: 'completed',
    });
    const error = await getDepositDetail('PC-1', CONFIG, FX, 'tok-1').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GmpayError);
    expect(classifyRequeryError(error).kind).toBe('ambiguous');
  });

  it("a payout's net is what our wallet paid: amount plus their fee", async () => {
    answer({
      status_code: 0,
      tran_token: 'tok-w',
      tran_unique: 'PW-1',
      tran_amount: 100,
      tran_fee: 2,
      tran_status: 'rejected',
    });
    const d = await getWithdrawalDetail('PW-1', CONFIG, FX, 'tok-w');
    expect(d.state).toBe('failed');
    expect(d.netAmount).toBe(325.38);
  });
});

describe('GMpay submits', () => {
  const deposit = {
    merchantTransactionId: 'PC-1',
    merchantClientId: 'cus_1',
    amount: 319,
    gatewayAmount: 100,
    notifyUrl: 'https://api.example.test/hooks/gmpay/deposit',
    returnUrl: 'https://example.test/me',
    ipAddress: '1.2.3.4',
    paymentMethodCode: 'BQR',
    payerName: 'TAN AH KOW',
  };

  it('refuses before any call: unknown method, no S$ amount, no paying account', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    for (const input of [
      { ...deposit, paymentMethodCode: 'FPX' },
      { ...deposit, gatewayAmount: undefined },
      deposit, // no payerBank
    ]) {
      const error = await submitDeposit(input, CONFIG).catch((e: unknown) => e);
      expect((error as GmpayError).definite).toBe(true);
      expect((error as GmpayError).result).toBe('not-sent');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a payout to a bank it has no code for, before any call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const error = await submitWithdrawal(
      {
        merchantTransactionId: 'PW-1',
        merchantClientId: 'cus_1',
        amount: 100,
        gatewayAmount: 31.15,
        destinationBankCode: 'NOT-A-BANK',
        destinationAccountNumber: '1234567890',
        destinationAccountHolderName: 'TAN AH KOW',
        notifyUrl: 'https://api.example.test/hooks/gmpay/withdrawal',
        returnUrl: '',
        ipAddress: '1.2.3.4',
      },
      CONFIG,
    ).catch((e: unknown) => e);
    expect((error as GmpayError).result).toBe('not-sent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('signs what it sends (sanity: the client is the one in use)', () => {
    expect(gmpaySign({ a: 1 }, 'k')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('refundsWithoutLookup', () => {
  const named = (result?: string, available?: number) =>
    new GatewayError('x', [], 400, true, {
      result: result as never,
      available,
    });

  it('GMpay: a refusal known to create nothing refunds at once', () => {
    expect(refundsWithoutLookup(named('creates-nothing'), 'gmpay')).toBe(true);
  });

  it('GMpay: a wallet our balance read found short refunds; an unconfirmed one waits', () => {
    expect(refundsWithoutLookup(named('wallet-empty', 3), 'gmpay')).toBe(true);
    expect(refundsWithoutLookup(named('wallet-empty'), 'gmpay')).toBe(false);
  });

  it('GMpay: any other refusal waits for a human (it may have been created)', () => {
    expect(refundsWithoutLookup(named('refused'), 'gmpay')).toBe(false);
  });

  it('a gateway that can be asked by our reference still asks first', () => {
    expect(refundsWithoutLookup(named('creates-nothing'), 'tgpay')).toBe(false);
    expect(refundsWithoutLookup(named('wallet-empty', 3), 'a3pay')).toBe(false);
  });

  it('every gateway refunds payouts-off and not-sent at their word', () => {
    for (const gateway of ['tgpay', 'a3pay', 'gmpay'] as const) {
      expect(refundsWithoutLookup(named('payouts-off'), gateway)).toBe(true);
      expect(refundsWithoutLookup(named('not-sent'), gateway)).toBe(true);
    }
  });
});

describe('GMpay status check amounts', () => {
  it('reads what actually arrived, not the asked sum', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 0,
          tran_token: 'tok-1',
          tran_unique: 'PC-1',
          tran_amount: 100,
          tran_actual_amount: 100.01,
          tran_status: 'completed',
        }),
        { status: 200 },
      ),
    );
    const d = await getDepositDetail('PC-1', CONFIG, FX, 'tok-1');
    expect(d.reportedAmount).toBe(100.01);
  });
});

describe("GMpay's Singapore bank codes", () => {
  it('pays every Singapore bank we offer except Alliance, and no Malaysian bank', () => {
    const served = banksFor('gmpay', { env: {} }).map((b) => b.bankCode);
    const offered = SG_BANKS.filter((b) => b.accountLengths?.length).map((b) => b.id);
    expect(served).toEqual(offered);
    expect(served).not.toContain('ALLIANCESG');
    for (const bank of MY_BANKS) expect(bank.codes.gmpay).toBeUndefined();
  });

  it("sends GMpay's own codes, never A3Pay's", () => {
    expect(gatewayBankCode('DBSSSGSG', 'gmpay', {})?.code).toBe('DBS');
    expect(gatewayBankCode('POSBSG', 'gmpay', {})?.code).toBe('POSB');
    expect(gatewayBankCode('HLBBSGSG', 'gmpay', {})?.code).toBe('HLBBSG');
    expect(gatewayBankCode('MBBESGSG', 'gmpay', {})?.code).toBe('MAYBANK');
    expect(gatewayBankCode('PAYNOWSG', 'gmpay', {})?.code).toBe('PAYNOW');
    expect(gatewayBankCode('DBSSSGSG', 'a3pay', {})?.code).toBe('SDBS');
  });
});

describe("GMpay's S$ limits sit inside its channel limits", () => {
  // GMpay back office "Payment channel limit" (2026-11-20): IN S$20–20,000,
  // OUT S$50–200,000. A S$50 payout was still refused (AMOUNT_NOT_IN_RANGE),
  // so the floor sits above 50 until GMpay says whether 50 itself is allowed.
  it('never asks GMpay for a payout at or below S$50, or a top-up below S$20', () => {
    const l = GATEWAYS.gmpay.currencyLimits!;
    expect(l.withdrawalMin).toBeGreaterThan(50);
    expect(l.withdrawalMax).toBeLessThanOrEqual(200000);
    expect(l.depositMin).toBeGreaterThanOrEqual(20);
    expect(l.depositMax).toBeLessThanOrEqual(20000);
  });
});
