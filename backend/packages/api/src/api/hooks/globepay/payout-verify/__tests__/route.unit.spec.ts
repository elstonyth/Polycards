import { generateKeyPairSync } from 'node:crypto';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { aesEncrypt, signPayload } from '../../../../../modules/packs/globepay';
import { POST } from '../route';

// Payout Verification (§1.7): "success" lets the payout proceed, anything
// else rejects it. The safe failure direction is refusal — a wrongly-refused
// payout refunds via their fail callback; a wrongly-approved one is gone.

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AES_KEY = 'test-aes-key';

beforeEach(() => {
  // The host has no default (see globepayConfigFromEnv): CI has no .env,
  // so a spec that leans on an ambient value passes locally and fails there.
  process.env.GLOBEPAY_API_BASE = 'https://mapi.example.test';
  process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
  process.env.GLOBEPAY_AES_KEY = AES_KEY;
  process.env.GLOBEPAY_MERCHANT_PRIVATE_KEY = privateKey;
  process.env.GLOBEPAY_PUBLIC_KEY = publicKey;
});

const verification = {
  MerchantCode: 'Testpolycard',
  CurrencyCode: 'MYR',
  MerchantTransactionId: 'PC-W1',
  Amount: 50,
};

function body(data: Record<string, unknown>, signWith = privateKey) {
  const json = JSON.stringify(data);
  return {
    MerchantCode: 'Testpolycard',
    Data: aesEncrypt(json, AES_KEY),
    Signature: signPayload(json, signWith),
    Version: 0,
  };
}

function harness(withdrawal: Record<string, unknown> | null) {
  const packs = {
    listGlobePayWithdrawals: jest
      .fn()
      .mockResolvedValue(withdrawal ? [withdrawal] : []),
    // Present only so the guard below can prove the recorder no longer goes
    // through it — the generated update bumps updated_at, the sweep's submit
    // clock (review 2026-09).
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
  };
  // The breadcrumb's raw writer.
  const pg = { raw: jest.fn().mockResolvedValue(undefined) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    body: {},
    scope: {
      resolve: (k: string) =>
        k === 'logger'
          ? logger
          : k === ContainerRegistrationKeys.PG_CONNECTION
            ? pg
            : packs,
    },
  } as never;
  const res = {
    statusCode: 0,
    body: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
  };
  return { packs, pg, logger, req, res };
}

/** The recorder's write, as [sql, bindings]. */
const recorded = (h: ReturnType<typeof harness>) => h.pg.raw.mock.calls;

const run = async (
  h: ReturnType<typeof harness>,
  payload: Record<string, unknown>,
) => {
  (h.req as { body: unknown }).body = payload;
  await POST(h.req, h.res as never);
  return h.res;
};

const pendingRow = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-W1',
  amount: 50,
  status: 'pending',
};

describe('payout verification', () => {
  it('approves a pending payout we recorded, at the exact amount we debited', async () => {
    const h = harness(pendingRow);
    const res = await run(h, body(verification));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
  });

  it('refuses a payout we have no row for', async () => {
    const h = harness(null);
    const res = await run(h, body(verification));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toBe('success');
  });

  it('refuses when the amount differs from the debit', async () => {
    const h = harness(pendingRow);
    const res = await run(h, body({ ...verification, Amount: 500 }));
    expect(res.statusCode).toBe(400);
  });

  it('refuses a matching amount in the wrong currency', async () => {
    const h = harness(pendingRow);
    // 50 VND is not RM 50 — a currency-blind amount match would approve it.
    const res = await run(h, body({ ...verification, CurrencyCode: 'VND' }));
    expect(res.statusCode).toBe(400);
  });

  it('refuses a payout whose row is no longer pending', async () => {
    const h = harness({ ...pendingRow, status: 'failed' });
    const res = await run(h, body(verification));
    expect(res.statusCode).toBe(400);
  });

  it('refuses a verification naming a different merchant', async () => {
    const h = harness(pendingRow);
    // The envelope MerchantCode (set by body()) still says 'Testpolycard' — a
    // guard reading THAT would approve this. Only the signed copy counts.
    const res = await run(
      h,
      body({ ...verification, MerchantCode: 'Someone' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toBe('success');
    // The lookup that DOES happen here is the plan-095 recorder, not a gate:
    // the refusal above is already decided, and the row is read only so the
    // reason can be written to it. Before that recorder existed this asserted
    // no lookup at all — the property worth keeping is that a mismatched
    // merchant never reaches an approval, which the two assertions above
    // cover.
    expect(recorded(h)).toEqual([
      [
        expect.stringContaining('verify_outcome'),
        [expect.stringContaining('rejected: names merchant'), 'gpw_1'],
      ],
    ]);
  });

  it('approves a merchant code differing only in case', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      body({ ...verification, MerchantCode: 'TESTPOLYCARD' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
  });

  // Plan 095. Their Payout Verification is ACTIVE in production, so the row's
  // record of it is the only thing that distinguishes "we refused their
  // verification" from "their verification never reached us" once
  // DigitalOcean has rotated the run logs away.
  describe('records the outcome on the row', () => {
    it('stamps success on an approved payout', async () => {
      const h = harness(pendingRow);
      await run(h, body(verification));
      expect(recorded(h)).toEqual([
        [
          expect.stringMatching(
            /^UPDATE globepay_withdrawal SET verify_outcome = \?/,
          ),
          [expect.stringContaining('success'), 'gpw_1'],
        ],
      ]);
    });

    // The sweep reads a pending row's updated_at as its SUBMIT clock, and
    // the not-found refund of an ambiguous submit waits on it. A verification
    // landing on such a row used to push that refund out by up to an hour
    // per call (review 2026-09): the breadcrumb must not move the clock.
    it('writes the breadcrumb WITHOUT touching updated_at, and not through the generated update', async () => {
      const h = harness(pendingRow);
      await run(h, body(verification));
      const [sql] = recorded(h)[0];
      expect(sql).not.toMatch(/updated_at/);
      expect(sql).toContain('WHERE id = ?');
      expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    });

    it('names the amount when that is what refused it', async () => {
      const h = harness(pendingRow);
      await run(h, body({ ...verification, Amount: 500 }));
      expect(recorded(h)[0][1]).toEqual([
        expect.stringContaining('rejected: amount 500 != debited 50'),
        'gpw_1',
      ]);
    });

    it('names the currency rather than blaming the amount', async () => {
      const h = harness(pendingRow);
      await run(h, body({ ...verification, CurrencyCode: 'VND' }));
      // The pre-095 route collapsed both checks into one message that always
      // said "amount", which would have sent an operator hunting a mismatch
      // that did not exist.
      expect(recorded(h)[0][1]).toEqual([
        expect.stringContaining('rejected: currency VND'),
        'gpw_1',
      ]);
    });

    it('names the status when the row has already closed', async () => {
      const h = harness({ ...pendingRow, status: 'failed' });
      await run(h, body(verification));
      expect(recorded(h)[0][1]).toEqual([
        expect.stringContaining('rejected: row status is'),
        'gpw_1',
      ]);
    });

    it('writes nothing when no row matches the reference', async () => {
      const h = harness(null);
      const res = await run(h, body(verification));
      expect(res.statusCode).toBe(400);
      expect(h.pg.raw).not.toHaveBeenCalled();
    });

    it('still approves when the recording write fails', async () => {
      const h = harness(pendingRow);
      h.pg.raw.mockRejectedValue(new Error('db down'));
      const res = await run(h, body(verification));
      // A breadcrumb must never cost a payout: anything but "success" here
      // makes GlobePay reject a withdrawal we had already debited.
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('success');
    });
  });

  it('refuses a verification signed with the wrong key', async () => {
    const attacker = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const h = harness(pendingRow);
    const res = await run(h, body(verification, attacker.privateKey));
    expect(res.statusCode).toBe(400);
  });
});
