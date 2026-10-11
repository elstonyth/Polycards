import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import {
  createPayment,
  tgpayCallbackAuthorized,
  tgpayCallbackIpVerdict,
  tgpayFamilyConfigFromEnv,
  TgpayError,
  type TgpayConfig,
} from '../tgpay-client';
import {
  GATEWAYS,
  GATEWAY_IDS,
  gatewayConfigFor,
  submitDeposit,
  submitWithdrawal,
  tgpayCheckoutBase,
} from '../gateway';
import { banksFor, gatewayBankCode, sandboxOnlyBank } from '../banks';
import { bankSupportedBy } from '../saved-accounts';

// The 7 Pay is a white-label of the platform TGPay runs on (docs/payments/
// the7pay-api.md): same wire format, its own host, keys and env prefix, plus
// optional RSA request signing and an HMAC callback mode. These specs pin
// what is different; everything shared is covered by tgpay-client's spec.

const env = {
  THE7PAY_API_BASE: 'https://sandbox-api.the7pay.test/api/v1/',
  THE7PAY_PUBLIC_KEY: 'pk-7',
  THE7PAY_SECRET_KEY: 'sk-7',
} as NodeJS.ProcessEnv;

const config: TgpayConfig<'the7pay'> = {
  kind: 'the7pay',
  baseUrl: 'https://sandbox-api.the7pay.test/api/v1',
  publicKey: 'pk-7',
  secretKey: 'sk-7',
  currencyCode: 'MYR',
};

type RawCall = { url: string; headers: Record<string, string>; raw: string };

function stubFetch(response: unknown, status = 200): RawCall[] {
  const calls: RawCall[] = [];
  global.fetch = jest.fn(
    async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, headers: init.headers, raw: init.body });
      return { status, text: async () => JSON.stringify(response) };
    },
  ) as unknown as typeof fetch;
  return calls;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const created = {
  status: 1,
  msg: 'Success',
  data: { checkoutLink: '/checkout?order=abcdef0123456789abcdef0123456789' },
};

describe('tgpayFamilyConfigFromEnv("the7pay")', () => {
  it('reads the THE7PAY_* names, never TGPay’s', () => {
    const cfg = tgpayFamilyConfigFromEnv('the7pay', {
      ...env,
      TGPAY_API_BASE: 'https://api.tgpay.test/api/v2',
      TGPAY_SECRET_KEY: 'sk-tgpay',
    });
    expect(cfg).toEqual({
      kind: 'the7pay',
      baseUrl: 'https://sandbox-api.the7pay.test/api/v1',
      publicKey: 'pk-7',
      secretKey: 'sk-7',
      currencyCode: 'MYR',
    });
  });

  it('names the missing THE7PAY variable', () => {
    expect(() =>
      tgpayFamilyConfigFromEnv('the7pay', {
        ...env,
        THE7PAY_SECRET_KEY: undefined,
      }),
    ).toThrow(/The 7 Pay: missing required env var THE7PAY_SECRET_KEY/);
  });

  it('takes an RSA private key with escaped newlines (single-line env value)', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const cfg = tgpayFamilyConfigFromEnv('the7pay', {
      ...env,
      THE7PAY_RSA_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
    });
    expect(cfg.rsaPrivateKey).toBe(pem);
  });

  it('refuses an unreadable RSA key at config time, before any call', () => {
    expect(() =>
      tgpayFamilyConfigFromEnv('the7pay', {
        ...env,
        THE7PAY_RSA_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----',
      }),
    ).toThrow(/THE7PAY_RSA_PRIVATE_KEY is not a readable PEM private key/);
  });
});

describe('RSA request signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('signs METHOD\\nPATH-with-prefix\\nRAW_BODY and sends that exact body', async () => {
    const calls = stubFetch(created);
    await createPayment(
      {
        merchantRefNum: 'PC-1',
        amount: 50,
        notifyUrl: 'https://api.example.test/hooks/the7pay/deposit',
        redirectUrl: 'https://example.test/wallet',
        customer: { name: 'A', email: 'a@example.test', phoneNumber: '0123' },
      },
      { ...config, rsaPrivateKey: pem },
    );
    const [call] = calls;
    expect(call.url).toBe(
      'https://sandbox-api.the7pay.test/api/v1/transaction/create-payment',
    );
    const signature = call.headers['x-rsa-signature'];
    expect(signature).toBeTruthy();
    const signed = `POST\n/api/v1/transaction/create-payment\n${call.raw}`;
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(signed, 'utf8'),
        publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('sends no signature header without a key (pk/sk only)', async () => {
    const calls = stubFetch(created);
    await createPayment(
      {
        merchantRefNum: 'PC-1',
        amount: 50,
        notifyUrl: 'n',
        redirectUrl: 'r',
        customer: { name: 'A', email: 'a@example.test', phoneNumber: '0123' },
      },
      config,
    );
    expect(calls[0].headers).not.toHaveProperty('x-rsa-signature');
    expect(calls[0].headers['x-public-key']).toBe('pk-7');
  });

  it('labels errors with the gateway that refused', async () => {
    stubFetch({ statusCode: 401, message: 'Invalid RSA signature' }, 401);
    await expect(
      createPayment(
        {
          merchantRefNum: 'PC-1',
          amount: 50,
          notifyUrl: 'n',
          redirectUrl: 'r',
          customer: { name: 'A', email: 'a@example.test', phoneNumber: '0' },
        },
        config,
      ),
    ).rejects.toThrow(/^The 7 Pay \/transaction\/create-payment failed/);
  });
});

describe('callback authentication', () => {
  const raw = JSON.stringify({ status: 1, data: { merchantRefNum: 'PC-1' } });
  const hmac = createHmac('sha256', 'pk-7sk-7')
    .update(raw, 'utf8')
    .digest('hex');

  it('accepts Method 2: hex HMAC-SHA256 of the raw body keyed pk+sk', () => {
    expect(tgpayCallbackAuthorized({ 'x-signature': hmac }, config, raw)).toBe(
      true,
    );
  });

  it('refuses a wrong signature, a tampered body, or no raw body', () => {
    expect(
      tgpayCallbackAuthorized({ 'x-signature': '00'.repeat(32) }, config, raw),
    ).toBe(false);
    expect(
      tgpayCallbackAuthorized({ 'x-signature': hmac }, config, `${raw} `),
    ).toBe(false);
    expect(tgpayCallbackAuthorized({ 'x-signature': hmac }, config)).toBe(
      false,
    );
  });

  it('still accepts Method 1 (the key headers)', () => {
    expect(
      tgpayCallbackAuthorized(
        { 'x-public-key': 'pk-7', 'x-secret-key': 'sk-7' },
        config,
      ),
    ).toBe(true);
  });
});

describe('callback source allowlist', () => {
  it('reads THE7PAY_CALLBACK_IPS, not TGPay’s list', () => {
    const both = {
      TGPAY_CALLBACK_IPS: '1.1.1.1',
      THE7PAY_CALLBACK_IPS: '2.2.2.0/24',
      THE7PAY_API_BASE: 'https://api.the7pay.test/api/v1',
    };
    expect(tgpayCallbackIpVerdict('2.2.2.9', both, 'the7pay')).toEqual({
      allowed: true,
    });
    expect(tgpayCallbackIpVerdict('1.1.1.1', both, 'the7pay')).toEqual({
      allowed: false,
      reason: 'not-listed',
    });
  });

  it('refuses production without a list; the sandbox may run header-only', () => {
    expect(
      tgpayCallbackIpVerdict(
        '9.9.9.9',
        { THE7PAY_API_BASE: 'https://api.the7pay.test/api/v1' },
        'the7pay',
      ),
    ).toEqual({ allowed: false, reason: 'unset-in-production' });
    expect(
      tgpayCallbackIpVerdict(
        '9.9.9.9',
        { THE7PAY_API_BASE: 'https://sandbox-api.the7pay.test/api/v1' },
        'the7pay',
      ),
    ).toEqual({ allowed: true, reason: 'sandbox-no-list' });
  });
});

describe('registry', () => {
  it('is an operator choice with its own credentials and hooks', () => {
    expect(GATEWAY_IDS).toContain('the7pay');
    const def = GATEWAYS.the7pay;
    expect(def.configured(env)).toBe(true);
    expect(def.configured({ TGPAY_SECRET_KEY: 'sk' })).toBe(false);
    expect(def.hooks).toEqual({
      deposit: '/hooks/the7pay/deposit',
      withdrawal: '/hooks/the7pay/withdrawal',
    });
    // Payout floor read from the production tenant 2026-10-09.
    expect(def.limits.withdrawalMin).toBe(100);
    expect(gatewayConfigFor('the7pay', env).kind).toBe('the7pay');
  });

  it('pairs api. with checkout. on its own host, or THE7PAY_CHECKOUT_BASE', () => {
    expect(tgpayCheckoutBase(config, {})).toBe(
      'https://sandbox-checkout.the7pay.test',
    );
    expect(
      tgpayCheckoutBase(config, {
        TGPAY_CHECKOUT_BASE: 'https://wrong.test',
        THE7PAY_CHECKOUT_BASE: 'https://pay.the7pay.test/',
      }),
    ).toBe('https://pay.the7pay.test');
  });

  it('submits a deposit to its own host with an absolute checkout link', async () => {
    const calls = stubFetch(created);
    const result = await submitDeposit(
      {
        merchantTransactionId: 'PC-1',
        merchantClientId: 'cus_1',
        amount: 50,
        notifyUrl: 'https://api.example.test/hooks/the7pay/deposit',
        returnUrl: 'https://example.test/wallet',
        ipAddress: '1.2.3.4',
        paymentMethodCode: 'OB',
        customer: { name: 'A', email: 'a@example.test', phoneNumber: '0123' },
      },
      config,
    );
    expect(calls[0].url).toMatch(/^https:\/\/sandbox-api\.the7pay\.test\//);
    expect(result.url).toBe(
      'https://sandbox-checkout.the7pay.test/checkout?order=abcdef0123456789abcdef0123456789',
    );
    expect(result.transactionId).toBe('abcdef0123456789abcdef0123456789');
  });

  it('refuses an unknown bank as a definite error named for the gateway', async () => {
    const error = await submitWithdrawal(
      {
        merchantTransactionId: 'WD-1',
        merchantClientId: 'cus_1',
        amount: 100,
        destinationBankCode: 'NOPE',
        destinationAccountNumber: '1',
        destinationAccountHolderName: 'A',
        notifyUrl: 'n',
        returnUrl: 'r',
        ipAddress: '1.2.3.4',
        email: 'a@example.test',
      },
      config,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TgpayError);
    expect((error as TgpayError).definite).toBe(true);
    expect((error as TgpayError).message).toMatch(/^The 7 Pay:/);
  });
});

describe('banks', () => {
  it('pays to the same SWIFT pairs as TGPay', () => {
    expect(gatewayBankCode('MBBEMYKL', 'the7pay')).toEqual(
      gatewayBankCode('MBBEMYKL', 'tgpay'),
    );
    expect(banksFor('the7pay').length).toBe(banksFor('tgpay').length);
  });

  it('offers the sandbox dummy bank only on its own sandbox', () => {
    expect(banksFor('the7pay', { sandbox: true })[0].bankCode).toBe(
      'DUMMYBANKVERIFIED',
    );
    const mixed = {
      TGPAY_API_BASE: 'https://api.tgpay.test/api/v2',
      THE7PAY_API_BASE: 'https://sandbox-api.the7pay.test/api/v1',
    };
    expect(sandboxOnlyBank('DUMMYBANKVERIFIED', mixed, 'the7pay')).toBe(false);
    expect(sandboxOnlyBank('DUMMYBANKVERIFIED', mixed, 'tgpay')).toBe(true);
    expect(bankSupportedBy('DUMMYBANKVERIFIED', 'the7pay', mixed)).toBe(true);
    expect(bankSupportedBy('DUMMYBANKVERIFIED', 'tgpay', mixed)).toBe(false);
  });
});
