import {
  GmpayError,
  GMPAY_NO_TOKEN,
  gmpayConfigFromEnv,
  gmpayConfigured,
  gmpayPayinState,
  gmpayPayoutState,
  gmpaySign,
  payinQuery,
  readSignedCallback,
  submitPayout,
  type GmpayConfig,
} from '../gmpay-client';

const SECRET = 'test-secret-key';
const CONFIG: GmpayConfig = {
  kind: 'gmpay',
  baseUrl: 'https://xapi.example.test/v3',
  clientId: 'client-1',
  secretKey: SECRET,
  currencyCode: 'SGD',
};

const ENV = {
  GMPAY_API_BASE: 'https://xapi.example.test/v3/',
  GMPAY_CLIENT_ID: 'client-1',
  GMPAY_SECRET_KEY: SECRET,
};

afterEach(() => {
  jest.restoreAllMocks();
});

function answer(body: unknown, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );
}

describe('gmpaySign', () => {
  it("reproduces the API doc's own example signature", () => {
    expect(
      gmpaySign(
        {
          client_id: '93f3ab46-6745-11ee-9bb7-005056032122',
          cont_code: 'THB_PROMPTPAY',
          tran_customer: 'username',
          tran_customer_bank_code: 'SCB',
          tran_customer_bank_holder_name: 'Alex Tan Kah Liang',
          tran_customer_bank_account: '10123456789',
          tran_amount: 100,
          tran_unique: 'WX001',
        },
        '09894367dbe822244d6297271c704d79b0fdfe4e120ea94e8a8c9cd36d0e6b1d',
      ),
    ).toBe('d85c15754f3bd7a22a394ecc9849461f2e7acc874dce942d3e31c5f0f916210c');
  });

  it('skips empty values and the signature field itself', () => {
    const base = { a: '1', b: 'x' };
    expect(
      gmpaySign(
        { ...base, c: '', d: null, e: undefined, tran_signature: 'zz' },
        SECRET,
      ),
    ).toBe(gmpaySign(base, SECRET));
  });
});

describe('gmpayConfigFromEnv', () => {
  it('reads the credentials and drops a trailing slash', () => {
    expect(gmpayConfigFromEnv(ENV)).toEqual({
      kind: 'gmpay',
      baseUrl: 'https://xapi.example.test/v3',
      clientId: 'client-1',
      secretKey: SECRET,
      currencyCode: 'SGD',
    });
  });

  it('refuses plain http except on loopback (the local mock)', () => {
    expect(() =>
      gmpayConfigFromEnv({
        ...ENV,
        GMPAY_API_BASE: 'http://xapi.example.test/v3',
      }),
    ).toThrow(/https/);
    expect(
      gmpayConfigFromEnv({ ...ENV, GMPAY_API_BASE: 'http://127.0.0.1:4466/v3' })
        .baseUrl,
    ).toBe('http://127.0.0.1:4466/v3');
  });

  it('is configured only with every credential present', () => {
    expect(gmpayConfigured(ENV)).toBe(true);
    expect(gmpayConfigured({ ...ENV, GMPAY_SECRET_KEY: '' })).toBe(false);
    expect(() => gmpayConfigFromEnv({ ...ENV, GMPAY_CLIENT_ID: '' })).toThrow(
      /GMPAY_CLIENT_ID/,
    );
  });
});

describe('readSignedCallback', () => {
  function signedRaw(fields: Record<string, unknown>, secret = SECRET): string {
    const signature = gmpaySign(fields, secret);
    return JSON.stringify({ ...fields, tran_signature: signature });
  }

  it('accepts a callback signed with our secret', () => {
    const raw = signedRaw({
      status_code: 0,
      tran_token: 'tok-1',
      tran_unique: 'PC-1',
      tran_status: 'completed',
      tran_amount: 100,
    });
    expect(readSignedCallback(raw, CONFIG)).toMatchObject({
      tran_token: 'tok-1',
      tran_unique: 'PC-1',
      tran_status: 'completed',
    });
  });

  it('signs numbers as they were WRITTEN: "100.00" is not "100"', () => {
    // A re-serialised body would hash 100, not the 100.00 they signed.
    const signature = gmpaySign(
      { tran_unique: 'PC-1', tran_amount: '100.00', tran_fee: '1.10' },
      SECRET,
    );
    const raw = `{"tran_unique":"PC-1","tran_amount":100.00,"tran_fee":1.10,"tran_signature":"${signature}"}`;
    expect(readSignedCallback(raw, CONFIG).tran_amount).toBe('100.00');
  });

  it('refuses a tampered, foreign or unsigned callback', () => {
    const raw = signedRaw({ tran_unique: 'PC-1', tran_amount: 100 });
    expect(() =>
      readSignedCallback(
        raw.replace('"tran_amount":100', '"tran_amount":900'),
        CONFIG,
      ),
    ).toThrow(/signature/);
    expect(() =>
      readSignedCallback(
        signedRaw({ tran_unique: 'PC-1' }, 'someone-else'),
        CONFIG,
      ),
    ).toThrow(/signature/);
    expect(() => readSignedCallback('{"tran_unique":"PC-1"}', CONFIG)).toThrow(
      /signature/,
    );
    expect(() => readSignedCallback('not json', CONFIG)).toThrow();
  });

  it('refuses a nested body rather than guess what was signed', () => {
    const raw = `{"tran_unique":"PC-1","extra":{"a":1},"tran_signature":"x"}`;
    expect(() => readSignedCallback(raw, CONFIG)).toThrow();
  });
});

describe('states', () => {
  it('maps pay-in statuses', () => {
    expect(gmpayPayinState('completed')).toBe('success');
    expect(gmpayPayinState('expired')).toBe('failed');
    expect(gmpayPayinState('initiated')).toBe('pending');
    expect(gmpayPayinState('something new')).toBe('pending');
  });

  it('maps payout statuses', () => {
    expect(gmpayPayoutState('completed')).toBe('success');
    expect(gmpayPayoutState('rejected')).toBe('failed');
    expect(gmpayPayoutState('initiated')).toBe('pending');
    expect(gmpayPayoutState(undefined)).toBe('pending');
  });
});

describe('errors', () => {
  it('a status check without their token is unclear, never not-found', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const error = await payinQuery('', CONFIG).catch((e: unknown) => e);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(GmpayError);
    expect((error as GmpayError).has(GMPAY_NO_TOKEN)).toBe(true);
    expect((error as GmpayError).definite).toBe(false);
    expect((error as GmpayError).result).toBeUndefined();
    // 400, so the sweeps read it as ambiguous (wait), not a crash (rethrow).
    expect((error as GmpayError).httpStatus).toBe(400);
  });

  it('a lookup refusal is unclear, whatever it says', async () => {
    answer({ status_code: -1, status_msg: 'INVALID_IP' });
    const error = await payinQuery('tok', CONFIG).catch((e: unknown) => e);
    expect((error as GmpayError).definite).toBe(false);
    expect((error as GmpayError).result).toBeUndefined();
    expect((error as GmpayError).has('GMPAY_INVALID_IP')).toBe(true);
  });

  const payout = {
    merchantTransactionId: 'PC-9',
    customerId: 'cus_1',
    amount: 50,
    bankCode: 'DBS',
    accountName: 'A B',
    accountNumber: '0123456789',
    callbackUrl: 'https://x.test/hooks/gmpay/withdrawal',
  };

  it('a payout refused for our IP created nothing (definite)', async () => {
    answer({ status_code: -1, status_msg: 'INVALID_IP' });
    const error = await submitPayout(payout, CONFIG).catch((e: unknown) => e);
    expect((error as GmpayError).definite).toBe(true);
    expect((error as GmpayError).result).toBe('creates-nothing');
  });

  it('an unrecognised payout refusal stays unclear: it may have been created', async () => {
    answer({ status_code: -1, status_msg: 'SOMETHING_NEW' });
    const error = await submitPayout(payout, CONFIG).catch((e: unknown) => e);
    expect((error as GmpayError).definite).toBe(false);
  });

  it('a payout accepted without a token is unclear', async () => {
    answer({ status_code: 0, status_msg: 'NO_ERROR' });
    const error = await submitPayout(payout, CONFIG).catch((e: unknown) => e);
    expect((error as GmpayError).definite).toBe(false);
  });

  it('a 5xx or a non-JSON page is unclear', async () => {
    answer('<html>bad gateway</html>', 502);
    const error = await submitPayout(payout, CONFIG).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmpayError);
    expect((error as GmpayError).definite).toBe(false);
  });

  it('a balance hint on a payout refusal is tagged, still unclear until confirmed', async () => {
    answer({ status_code: -1, status_msg: 'INSUFFICIENT_BALANCE' });
    const error = await submitPayout(payout, CONFIG).catch((e: unknown) => e);
    expect((error as GmpayError).has('GMPAY_PAYOUT_FLOAT_EMPTY')).toBe(true);
    expect((error as GmpayError).definite).toBe(false);
  });

  it('signs every request it sends', async () => {
    const spy = answer({ status_code: 0, tran_token: 't-1', tran_amount: 50 });
    await submitPayout(payout, CONFIG);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    const { tran_signature, ...rest } = body;
    expect(tran_signature).toBe(gmpaySign(rest, SECRET));
    expect(rest).toMatchObject({
      client_id: 'client-1',
      currency: 'SGD',
      tran_unique: 'PC-9',
      tran_amount: 50,
      bank_code: 'DBS',
    });
  });
});
