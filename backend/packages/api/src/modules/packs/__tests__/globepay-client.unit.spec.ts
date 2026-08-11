import { generateKeyPairSync } from 'node:crypto';
import { aesDecrypt, verifySignature } from '../globepay';
import {
  GlobePayError,
  checkBalance,
  getDepositDetail,
  globepayConfigFromEnv,
  submitDeposit,
  type GlobePayConfig,
} from '../globepay-client';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const config: GlobePayConfig = {
  baseUrl: 'https://mapi.example.test',
  merchantCode: 'Testpolycard',
  // Throwaway — never the provider's real key (public repo, gitleaks).
  aesKey: 'test-aes-key',
  privateKey,
  publicKey,
  currencyCode: 'MYR',
};

/** Capture the outbound request instead of hitting the network. */
function stubFetch(response: unknown, status = 200) {
  const calls: { url: string; body: Record<string, string> }[] = [];
  global.fetch = jest.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      status,
      text: async () =>
        typeof response === 'string' ? response : JSON.stringify(response),
    };
  }) as unknown as typeof fetch;
  return calls;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('globepayConfigFromEnv', () => {
  it('defaults the currency but never the API host', () => {
    const cfg = globepayConfigFromEnv({
      GLOBEPAY_API_BASE: 'https://mapi.example.test',
      GLOBEPAY_MERCHANT_CODE: 'Testpolycard',
      GLOBEPAY_AES_KEY: 'k',
      GLOBEPAY_MERCHANT_PRIVATE_KEY: 'priv',
      GLOBEPAY_PUBLIC_KEY: 'pub',
    } as NodeJS.ProcessEnv);
    expect(cfg.currencyCode).toBe('MYR');
    expect(cfg.baseUrl).toBe('https://mapi.example.test');
  });

  // Regression: a missing host used to fall back to STAGING, which would have
  // pointed production credentials at the wrong environment silently.
  it('throws rather than falling back to the staging host', () => {
    expect(() =>
      globepayConfigFromEnv({
        GLOBEPAY_MERCHANT_CODE: 'Testpolycard',
        GLOBEPAY_AES_KEY: 'k',
        GLOBEPAY_MERCHANT_PRIVATE_KEY: 'priv',
        GLOBEPAY_PUBLIC_KEY: 'pub',
      } as NodeJS.ProcessEnv),
    ).toThrow(/missing required env var GLOBEPAY_API_BASE/);
  });

  it('strips a trailing slash so paths do not double up', () => {
    const cfg = globepayConfigFromEnv({
      GLOBEPAY_API_BASE: 'https://mapi.example.test/',
      GLOBEPAY_MERCHANT_CODE: 'M',
      GLOBEPAY_AES_KEY: 'k',
      GLOBEPAY_MERCHANT_PRIVATE_KEY: 'priv',
      GLOBEPAY_PUBLIC_KEY: 'pub',
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe('https://mapi.example.test');
  });

  it('throws on a missing secret rather than signing with an empty key', () => {
    expect(() =>
      globepayConfigFromEnv({
        GLOBEPAY_API_BASE: 'https://mapi.example.test',
        GLOBEPAY_AES_KEY: 'k',
      } as NodeJS.ProcessEnv),
    ).toThrow(/missing required env var GLOBEPAY_MERCHANT_CODE/);
  });
});

// The submit payload is irrelevant to the error-classification cases below;
// naming it once keeps them about the response shape they actually test.
const DEPOSIT_INPUT = {
  merchantTransactionId: 'T1',
  merchantClientId: 'c',
  amount: 25,
  notifyUrl: 'n',
  returnUrl: 'r',
  ipAddress: '1.2.3.4',
  paymentMethodCode: 'FPX',
};

describe('submitDeposit', () => {
  it('sends an envelope whose signature covers the encrypted payload', async () => {
    const calls = stubFetch({
      isSuccess: true,
      successCode: 200,
      data: {
        transactionId: 'D1',
        url: 'https://cashier/x',
        depositActualAmount: 25,
      },
    });

    await submitDeposit(
      {
        merchantTransactionId: 'T1',
        merchantClientId: 'cus_1',
        amount: 25,
        notifyUrl: 'https://us/notify',
        returnUrl: 'https://us/return',
        ipAddress: '1.2.3.4',
        paymentMethodCode: 'FPX',
      },
      config,
    );

    expect(calls[0].url).toBe(
      'https://mapi.example.test/api/Deposit/SubmitDeposit',
    );
    const sent = calls[0].body;
    // Recipient's view: decrypt Data, then verify Signature over those bytes.
    const json = aesDecrypt(sent.Data, config.aesKey);
    expect(verifySignature(json, sent.Signature, publicKey)).toBe(true);
    expect(JSON.parse(json)).toMatchObject({
      MerchantCode: 'Testpolycard',
      MerchantTransactionId: 'T1',
      CurrencyCode: 'MYR',
      // 2dp string, matching their sample — not the number 25.
      Amount: '25.00',
      PaymentMethodCode: 'FPX',
    });
  });

  it('omits SourceClientBankCode unless given (MYR methods do not use it)', async () => {
    const calls = stubFetch({
      isSuccess: true,
      data: { transactionId: 'D1', url: 'u', depositActualAmount: 1 },
    });
    await submitDeposit(
      {
        merchantTransactionId: 'T2',
        merchantClientId: 'c',
        amount: 1,
        notifyUrl: 'n',
        returnUrl: 'r',
        ipAddress: '1.2.3.4',
        paymentMethodCode: 'DN',
      },
      config,
    );
    const payload = JSON.parse(aesDecrypt(calls[0].body.Data, config.aesKey));
    expect(payload).not.toHaveProperty('SourceClientBankCode');
  });

  it('surfaces their error codes so callers can branch on PMT10000', async () => {
    stubFetch({
      isSuccess: false,
      errorList: [
        {
          errorCode: 'PMT10000',
          errorDescription: 'Duplicate Merchant Reference Number.',
        },
      ],
    });
    const call = submitDeposit(
      {
        merchantTransactionId: 'T1',
        merchantClientId: 'c',
        amount: 25,
        notifyUrl: 'n',
        returnUrl: 'r',
        ipAddress: '1.2.3.4',
        paymentMethodCode: 'FPX',
      },
      config,
    );
    await expect(call).rejects.toThrow(GlobePayError);
    await call.catch((e: GlobePayError) => {
      expect(e.has('PMT10000')).toBe(true);
      // An explicit refusal, so no transaction exists there and the caller is
      // entitled to refund and close the row.
      expect(e.definite).toBe(true);
    });
  });

  it('does not treat isSuccess:true with a null data as success', async () => {
    stubFetch({ isSuccess: true, data: null, errorMessage: 'nope' });
    await expect(submitDeposit(DEPOSIT_INPUT, config)).rejects.toThrow(/nope/);
  });

  // Capture the rejection rather than asserting inside `.catch`: a callback
  // that never runs is a test that never fails.
  const refusalFrom = async (body: unknown): Promise<GlobePayError> => {
    stubFetch(body);
    const error = await submitDeposit(DEPOSIT_INPUT, config).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GlobePayError);
    return error as GlobePayError;
  };

  // The distinction that decides whether a customer can be paid twice. Both
  // shapes throw; only one of them licenses a refund.
  it('marks isSuccess:true with no data AMBIGUOUS, not a refusal', async () => {
    // They ACCEPTED it; we just could not read the payload. Treating this as
    // definite would refund a payout that still executes on the withdrawal
    // path, and write off a live payment on the deposit path — and closing the
    // row drops it out of the sweep's status='pending' scan for good.
    const error = await refusalFrom({
      isSuccess: true,
      data: null,
      errorMessage: 'nope',
    });
    expect(error.definite).toBe(false);
  });

  it('marks a body with no isSuccess at all AMBIGUOUS', async () => {
    // A JSON error page from something sitting in front of them parses fine
    // but is not their envelope, so it proves nothing about the transaction.
    const error = await refusalFrom({ message: 'upstream connect error' });
    expect(error.definite).toBe(false);
  });

  it('still marks an explicit isSuccess:false DEFINITE, codes or not', async () => {
    // The DN channel refuses with an empty errorList (see the setup doc), so
    // "no codes" must not be read as "not a refusal" — this is the shape the
    // refund path depends on.
    const error = await refusalFrom({ isSuccess: false, errorList: [] });
    expect(error.definite).toBe(true);
  });

  it('reports a non-JSON body (WAF/error page) with its status', async () => {
    stubFetch('Not found', 400);
    await expect(getDepositDetail('nope', config)).rejects.toThrow(
      /non-JSON response \(HTTP 400\): Not found/,
    );
  });
});

describe('getDepositDetail', () => {
  it('maps statusId to a settlement state, keeping 4 non-final', async () => {
    stubFetch({
      isSuccess: true,
      data: {
        transactionId: 'D1',
        merchantTransactionId: 'T1',
        statusId: 4,
        amount: 25,
      },
    });
    await expect(getDepositDetail('T1', config)).resolves.toMatchObject({
      state: 'pending',
    });
  });

  it('maps 6 to success', async () => {
    stubFetch({
      isSuccess: true,
      data: {
        transactionId: 'D1',
        merchantTransactionId: 'T1',
        statusId: 6,
        amount: 25,
      },
    });
    await expect(getDepositDetail('T1', config)).resolves.toMatchObject({
      state: 'success',
    });
  });
});

describe('checkBalance', () => {
  it('posts only merchant code + currency', async () => {
    const calls = stubFetch({
      isSuccess: true,
      data: {
        merchantCode: 'Testpolycard',
        currencyCode: 'MYR',
        currentBalance: 0,
        availableBalance: 0,
        t1Balance: 0,
      },
    });
    await checkBalance(config);
    expect(JSON.parse(aesDecrypt(calls[0].body.Data, config.aesKey))).toEqual({
      MerchantCode: 'Testpolycard',
      CurrencyCode: 'MYR',
    });
  });
});
