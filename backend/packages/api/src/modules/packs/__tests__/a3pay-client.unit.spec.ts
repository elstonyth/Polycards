import {
  A3PAY_NOT_FOUND,
  A3PAY_PAYOUT_FLOAT_EMPTY,
  getPayinDetail,
  getPayoutDetail,
  checkAccBalance,
  submitPayout,
} from '../a3pay-client';
import { inRowCurrency, submitWithdrawal } from '../gateway';
import { generateKeyPairSync } from 'node:crypto';

// Response shapes measured live against A3Pay production on 2026-10-12.
const ours = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const config = {
  kind: 'a3pay' as const,
  baseUrl: 'https://mapi.example.test',
  merchantCode: 'polycards',
  aesKey: 'k',
  privateKey: ours.privateKey.toString('base64'),
  publicKey: ours.publicKey.toString('base64'),
  currencyCode: 'SGD',
};

function reply(status: number, body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    status,
    text: async () => body,
  }) as unknown as typeof fetch;
}

const NOT_FOUND =
  '{"isSuccess":false,"successCode":0,"errorCode":null,"errorMessage":"Not found","errorList":null,"data":null}';

describe('A3Pay live response shapes', () => {
  it('tags "Not found" on a payin or payout requery as definite not-found', async () => {
    for (const call of [getPayinDetail, getPayoutDetail]) {
      reply(400, NOT_FOUND);
      await expect(call('PC-x', config)).rejects.toMatchObject({
        definite: true,
        codes: [A3PAY_NOT_FOUND],
        result: 'not-found',
      });
    }
  });

  it('a wrong AES key (plain-text 400) is never not-found', async () => {
    reply(400, 'Invalid Request');
    const error = await getPayinDetail('PC-x', config).catch((e) => e);
    expect(error.codes).toEqual([]);
    expect(error.definite).toBe(false);
  });

  it('a wrong merchant code (403 problem+json) is never not-found', async () => {
    reply(403, '{"title":"Forbidden","status":403}');
    const error = await getPayoutDetail('PC-x', config).catch((e) => e);
    expect(error.codes).toEqual([]);
    expect(error.definite).toBe(false);
  });

  it('"Not found" from a NON-requery endpoint is not tagged', async () => {
    reply(400, NOT_FOUND);
    const error = await checkAccBalance(config).catch((e) => e);
    expect(error.codes).toEqual([]);
  });

  it('reads the live balance shape (lowercase mid, t1 balance)', async () => {
    reply(
      200,
      '{"isSuccess":true,"successCode":200,"errorCode":null,"errorMessage":"","errorList":null,"data":{"mid":"polycards","currCode":"SGD","currentBalanceAmount":0.00,"availableBalanceAmount":0.00,"t1BalanceAmount":0.00}}',
    );
    await expect(checkAccBalance(config)).resolves.toMatchObject({
      mid: 'polycards',
      currCode: 'SGD',
      availableBalanceAmount: 0,
    });
  });
});

describe('A3Pay refusals that are on OUR side', () => {
  const payout = {
    merchantTransactionId: 'PC-w1',
    customerId: 'cus_1',
    amount: 60,
    ipAddress: '1.2.3.4',
    bankCode: 'DBS',
    accountNumber: '0123456789',
    accountHolderName: 'TAN AH KOW',
    callbackUrl: 'https://api.example.test/hooks/a3pay/withdrawal',
    verifyUrl: 'https://api.example.test/hooks/a3pay/payout-verify',
  };

  it('a SubmitPayout refused for funds carries the float-empty HINT (confirmed by a balance read before use)', async () => {
    reply(
      400,
      '{"isSuccess":false,"errorCode":null,"errorMessage":"Insufficient balance","data":null}',
    );
    const error = await submitPayout(payout, config).catch((e) => e);
    expect(error.codes).toContain(A3PAY_PAYOUT_FLOAT_EMPTY);
    // A hint only: the adapter names it once its balance read confirms it.
    expect(error.result).toBe('refused');
  });

  it('any other SubmitPayout refusal does not — a bare "balance" included', async () => {
    for (const message of [
      'Invalid account number',
      'Account holder name does not match the balance account',
    ]) {
      reply(
        400,
        JSON.stringify({
          isSuccess: false,
          errorCode: null,
          errorMessage: message,
          data: null,
        }),
      );
      const error = await submitPayout(payout, config).catch((e) => e);
      expect(error.codes).not.toContain(A3PAY_PAYOUT_FLOAT_EMPTY);
    }
  });

  it('an isSuccess:false refusal is definite on a 2xx/4xx but NOT on a 5xx', async () => {
    const refused =
      '{"isSuccess":false,"errorCode":null,"errorMessage":"Invalid account number","data":null}';
    for (const [status, definite] of [
      [200, true],
      [400, true],
      // The payout may already be recorded on their side, and payouts are
      // posted by hand there: refunding now could pay the customer twice.
      [500, false],
      [502, false],
    ] as const) {
      reply(status, refused);
      const error = await submitPayout(payout, config).catch((e) => e);
      expect({ status, definite: error.definite }).toEqual({
        status,
        definite,
      });
    }
  });
});

describe('inRowCurrency — a requery asks in the currency the row was made in', () => {
  const fx = (currency?: string) => ({
    ledgerAmount: 300,
    gatewayAmount: 100,
    currency,
  });

  it('overrides a config whose currency has changed since', () => {
    const asked = inRowCurrency({ ...config, currencyCode: 'USD' }, fx('SGD'));
    expect('currencyCode' in asked && asked.currencyCode).toBe('SGD');
  });

  it('keeps the config for a pre-column row, and when they already agree', () => {
    expect(inRowCurrency(config, fx())).toBe(config);
    expect(inRowCurrency(config, fx('SGD'))).toBe(config);
  });
});

// The adapter, not the money path, turns A3Pay's balance hint into a named
// result: only its own balance read may confirm it (gateway.ts).
describe('the A3Pay adapter names a refusal', () => {
  const wd = {
    merchantTransactionId: 'PC-w1',
    merchantClientId: 'cus_1',
    amount: 330,
    destinationBankCode: 'DBSSSGSG',
    destinationAccountNumber: '0123456789',
    destinationAccountHolderName: 'TAN AH KOW',
    notifyUrl: 'https://api.example.test/hooks/a3pay/withdrawal',
    returnUrl: 'https://api.example.test/hooks/a3pay/payout-verify',
    ipAddress: '1.2.3.4',
    // S$100 needs S$101.50 in the float (A3Pay's own fee).
    gatewayAmount: 100,
  };
  const balance = (available: number) =>
    JSON.stringify({
      isSuccess: true,
      data: {
        currCode: 'SGD',
        currentBalanceAmount: available,
        availableBalanceAmount: available,
        t1BalanceAmount: 0,
      },
    });
  function route(read: string | Error, submit = 'Insufficient balance') {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).endsWith('CheckAccBalance')) {
        if (read instanceof Error) throw read;
        return { status: 200, text: async () => read };
      }
      return {
        status: 400,
        text: async () =>
          JSON.stringify({
            isSuccess: false,
            errorMessage: submit,
            data: null,
          }),
      };
    }) as unknown as typeof fetch;
  }

  it.each([
    ['short', balance(101), { result: 'wallet-empty', available: 101 }],
    ['enough', balance(500), { result: 'refused', available: undefined }],
    [
      'unreadable',
      new Error('socket hang up'),
      { result: 'refused', available: undefined },
    ],
  ])(
    'its balance hint with the float %s',
    async (_label, read, expected) => {
      route(read);
      const error = await submitWithdrawal(wd, config).catch((e) => e);
      expect(error).toMatchObject({ definite: true, ...expected });
      // The provider's own code stays on record either way.
      expect(error.codes).toContain(A3PAY_PAYOUT_FLOAT_EMPTY);
    },
  );

  it('any other refusal is not checked against the balance', async () => {
    route(balance(0), 'Invalid account number');
    const error = await submitWithdrawal(wd, config).catch((e) => e);
    expect(error.result).toBe('refused');
    expect(
      (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url)),
    ).toEqual(['https://mapi.example.test/api/Payout/SubmitPayout']);
  });

  it('a payout it refuses before calling A3Pay was not sent', async () => {
    route(balance(0));
    const error = await submitWithdrawal(
      { ...wd, gatewayAmount: undefined },
      config,
    ).catch((e) => e);
    expect(error).toMatchObject({ definite: true, result: 'not-sent' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
