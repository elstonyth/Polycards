import { GlobePayError } from '../globepay-client';
import {
  balances,
  createPayment,
  createPayout,
  orderFromCheckoutLink,
  queryPayment,
  tgpayCallbackAuthorized,
  tgpayCallbackIpVerdict,
  parseCallbackAllowlist,
  callbackIpAllowed,
  tgpayConfigFromEnv,
  tgpayPaymentState,
  TgpayError,
  TGPAY_NOT_FOUND,
  type TgpayConfig,
} from '../tgpay-client';

const config: TgpayConfig = {
  kind: 'tgpay',
  baseUrl: 'https://sandbox-api.example.test/api/v2',
  publicKey: 'pk-test',
  secretKey: 'sk-test',
  currencyCode: 'MYR',
};

type Call = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function stubFetch(response: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  global.fetch = jest.fn(
    async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        status,
        text: async () =>
          typeof response === 'string' ? response : JSON.stringify(response),
      };
    },
  ) as unknown as typeof fetch;
  return calls;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('tgpayConfigFromEnv', () => {
  it('requires the base URL and both keys, defaults the currency', () => {
    const cfg = tgpayConfigFromEnv({
      TGPAY_API_BASE: 'https://sandbox-api.example.test/api/v2/',
      TGPAY_PUBLIC_KEY: 'pk',
      TGPAY_SECRET_KEY: 'sk',
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe('https://sandbox-api.example.test/api/v2');
    expect(cfg.currencyCode).toBe('MYR');
    expect(cfg.kind).toBe('tgpay');
  });

  it('fails loudly on a missing key rather than signing with nothing', () => {
    expect(() =>
      tgpayConfigFromEnv({
        TGPAY_API_BASE: 'x',
        TGPAY_PUBLIC_KEY: 'pk',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TGPAY_SECRET_KEY/);
  });
});

describe('createPayment', () => {
  it('sends both key headers, an epoch, and the documented body shape', async () => {
    const calls = stubFetch({
      status: 1,
      msg: 'Success',
      data: { checkoutLink: '/checkout?order=abc123def456&amount=50.00' },
    });
    const before = Math.floor(Date.now() / 1000);
    const result = await createPayment(
      {
        merchantRefNum: 'PC-1',
        amount: 50,
        notifyUrl: 'https://us/notify',
        redirectUrl: 'https://us/return',
        customer: { name: 'A', email: 'a@x.test', phoneNumber: '0123456789' },
        paymentMethod: 'FPX',
      },
      config,
    );
    expect(calls[0].url).toBe(
      'https://sandbox-api.example.test/api/v2/transaction/create-payment',
    );
    expect(calls[0].headers['x-public-key']).toBe('pk-test');
    expect(calls[0].headers['x-secret-key']).toBe('sk-test');
    expect(calls[0].body.epoch as number).toBeGreaterThanOrEqual(before);
    expect(calls[0].body.order).toEqual({
      merchantRefNum: 'PC-1',
      amount: 50,
      notifyUrl: 'https://us/notify',
      redirectUrl: 'https://us/return',
      paymentMethod: 'FPX',
    });
    expect(result.order).toBe('abc123def456');
  });

  it('a JSON 4xx is a DEFINITE refusal; a 5xx is not', async () => {
    stubFetch({ statusCode: 400, message: 'amount out of range' }, 400);
    const refused = await createPayment(
      {
        merchantRefNum: 'PC-1',
        amount: 1,
        notifyUrl: 'n',
        redirectUrl: 'r',
        customer: { name: 'A', email: 'a', phoneNumber: '0' },
      },
      config,
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TgpayError);
    expect(refused).toBeInstanceOf(GlobePayError);
    expect((refused as TgpayError).definite).toBe(true);
    expect((refused as TgpayError).message).toMatch(/amount out of range/);

    stubFetch({ statusCode: 500, message: 'boom' }, 500);
    const ambiguous = await queryPayment('PC-1', config).catch(
      (e: unknown) => e,
    );
    expect((ambiguous as TgpayError).definite).toBe(false);
  });

  it('a 404 carries TGPAY_NOT_FOUND so the sweep can tell "unknown" from "refused"', async () => {
    stubFetch({ statusCode: 404, message: 'Transaction not found' }, 404);
    const err = (await queryPayment('PC-x', config).catch(
      (e: unknown) => e,
    )) as TgpayError;
    expect(err.has(TGPAY_NOT_FOUND)).toBe(true);
    expect(err.httpStatus).toBe(404);
  });

  it('a routing 404 (no such path) is NOT a transaction not-found — no refund on a wrong base URL', async () => {
    stubFetch(
      { statusCode: 404, message: 'Cannot POST /api/v3/transaction/query' },
      404,
    );
    const err = (await queryPayment('PC-x', config).catch(
      (e: unknown) => e,
    )) as TgpayError;
    expect(err.has(TGPAY_NOT_FOUND)).toBe(false);
    expect(err.httpStatus).toBe(404);
  });

  it('a non-JSON body (WAF page) is ambiguous and quotes the body', async () => {
    stubFetch('<html>blocked</html>', 403);
    const err = (await queryPayment('PC-x', config).catch(
      (e: unknown) => e,
    )) as TgpayError;
    expect(err.definite).toBe(false);
    expect(err.message).toMatch(/non-JSON/);
  });
});

describe('createPayout / balances', () => {
  it('rounds the amount to 2dp and returns their reference', async () => {
    const calls = stubFetch({
      status: 1,
      data: { transactionRefNum: 'tx-1', order: {}, recipient: {} },
    });
    const r = await createPayout(
      {
        merchantRefNum: 'PC-w1',
        amount: 100.006,
        email: 'a@x.test',
        userName: 'A',
        bankAccNumber: '1',
        bankCode: 'DUMMYBANKVERIFIED',
        bankName: 'Dummy Bank Verified',
        notifyUrl: 'n',
      },
      config,
    );
    expect(calls[0].url).toMatch(/\/transaction\/payout\/withdraw$/);
    expect(calls[0].body.amount).toBe(100.01);
    expect(r.transactionRefNum).toBe('tx-1');
  });

  it('reads both wallets', async () => {
    stubFetch({
      status: 1,
      data: { balance: 12.5, currency: { code: 'MYR', name: 'x' } },
    });
    const b = await balances(config);
    expect(b).toEqual({
      payin: 12.5,
      payout: 12.5,
      currencyCode: 'MYR',
      missing: [],
    });
  });

  it('a wallet the API has no row for reads as 0 but is named as missing', async () => {
    stubFetch({ statusCode: 404, message: 'Payout credit not found' }, 404);
    const b = await balances(config);
    expect(b.payin).toBe(0);
    expect(b.missing).toEqual(['payin', 'payout']);
  });
});

describe('pure helpers', () => {
  it('orderFromCheckoutLink reads the query param or the last path segment', () => {
    expect(orderFromCheckoutLink('/checkout?order=abc&datetime=x')).toBe('abc');
    expect(
      orderFromCheckoutLink(
        'https://api/transaction/create-payment/FPX/SANDBOX_BANK_FPX_MY/757bac9c12484e10a13239c61c7fce48',
      ),
    ).toBe('757bac9c12484e10a13239c61c7fce48');
    expect(orderFromCheckoutLink('/checkout')).toBeNull();
  });

  it('only APPROVED/SUCCESS credits and only an explicit reject fails; unknown stays pending', () => {
    expect(tgpayPaymentState('APPROVED')).toBe('success');
    expect(tgpayPaymentState('success')).toBe('success');
    expect(tgpayPaymentState('reject')).toBe('failed');
    // A payout that cancels or expires must release the customer's debit,
    // so the whole terminal-failure family closes the row.
    for (const s of ['CANCELLED', 'canceled', 'EXPIRED', 'void', 'DECLINED'])
      expect(tgpayPaymentState(s)).toBe('failed');
    expect(tgpayPaymentState('PENDING')).toBe('pending');
    expect(tgpayPaymentState('SOMETHING_NEW')).toBe('pending');
    expect(tgpayPaymentState('')).toBe('pending');
  });

  it('callback auth needs BOTH headers to match exactly', () => {
    const ok = { 'x-public-key': 'pk-test', 'x-secret-key': 'sk-test' };
    expect(tgpayCallbackAuthorized(ok, config)).toBe(true);
    expect(
      tgpayCallbackAuthorized({ ...ok, 'x-secret-key': 'sk-nope' }, config),
    ).toBe(false);
    expect(tgpayCallbackAuthorized({ 'x-public-key': 'pk-test' }, config)).toBe(
      false,
    );
    expect(
      tgpayCallbackAuthorized({ ...ok, 'x-secret-key': ['sk-test'] }, config),
    ).toBe(false);
    expect(tgpayCallbackAuthorized({}, config)).toBe(false);
  });
});

describe('callback source allowlist', () => {
  it('parses plain IPs and CIDR blocks, dropping garbage', () => {
    const entries = parseCallbackAllowlist(
      '1.32.102.191, 188.114.96.0/20 nonsense 300.1.1.1 54.251.58.7/33 47.131.132.118',
    );
    expect(entries).toHaveLength(3);
    expect(callbackIpAllowed('1.32.102.191', entries)).toBe(true);
    expect(callbackIpAllowed('1.32.102.192', entries)).toBe(false);
    expect(callbackIpAllowed('188.114.100.7', entries)).toBe(true); // inside /20
    expect(callbackIpAllowed('188.114.112.1', entries)).toBe(false); // outside /20
    expect(callbackIpAllowed('47.131.132.118', entries)).toBe(true);
    expect(callbackIpAllowed('not-an-ip', entries)).toBe(false);
  });

  it('a trailing slash or an odd mask is dropped, never read as /0', () => {
    expect(parseCallbackAllowlist('1.32.102.19/')).toEqual([]);
    expect(parseCallbackAllowlist('1.32.102.19/0x10 1.32.102.19/1e1')).toEqual(
      [],
    );
    expect(parseCallbackAllowlist('1.32.102.19/33')).toEqual([]);
    expect(parseCallbackAllowlist('1.32.102.19/a/b')).toEqual([]);
    expect(parseCallbackAllowlist('0.0.0.0/0')).toEqual([]);
    expect(parseCallbackAllowlist('0.0.0.0/1 128.0.0.0/1')).toHaveLength(2);
  });

  it('verdict: sandbox may run header-only; production without a list, or with a garbage list, refuses', () => {
    const sandbox = { TGPAY_API_BASE: 'https://sandbox-api.x/api/v2' };
    const prod = { TGPAY_API_BASE: 'https://api.x/api/v2' };
    expect(tgpayCallbackIpVerdict('1.2.3.4', sandbox)).toEqual({
      allowed: true,
      reason: 'sandbox-no-list',
    });
    expect(tgpayCallbackIpVerdict('1.2.3.4', prod)).toEqual({
      allowed: false,
      reason: 'unset-in-production',
    });
    expect(
      tgpayCallbackIpVerdict('1.2.3.4', {
        ...prod,
        TGPAY_CALLBACK_IPS: '1.2.3.4;5.6.7.8',
      }),
    ).toEqual({ allowed: false, reason: 'unparseable' });
    const env = { ...prod, TGPAY_CALLBACK_IPS: '1.32.102.19,54.251.58.7' };
    expect(tgpayCallbackIpVerdict('54.251.58.7', env)).toEqual({
      allowed: true,
    });
    expect(tgpayCallbackIpVerdict('54.251.58.8', env)).toEqual({
      allowed: false,
      reason: 'not-listed',
    });
    expect(tgpayCallbackIpVerdict('2001:db8::1', env).allowed).toBe(false);
  });
});
