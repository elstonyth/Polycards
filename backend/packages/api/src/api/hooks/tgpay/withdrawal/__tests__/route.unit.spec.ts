jest.mock('../../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../../modules/packs/withdrawal-receipt', () => ({
  sendWithdrawalReceipt: jest.fn().mockResolvedValue(undefined),
}));
// Both halves of the payout outcome are deep modules shared with the sweep;
// this route's job is to decide WHICH one and with what. Their own behaviour
// is proved against a real database in
// modules/packs/__tests__/withdrawal-outcome.integration.spec.ts and
// withdrawal-forensics.integration.spec.ts.
jest.mock('../../../../../modules/packs/gateway-withdrawal', () => ({
  refundWithdrawal: jest.fn().mockResolvedValue({ replayed: false }),
  applyWithdrawalOutcome: jest.fn().mockResolvedValue({ replayed: false }),
}));

import { POST } from '../route';
import {
  applyWithdrawalOutcome,
  refundWithdrawal,
} from '../../../../../modules/packs/gateway-withdrawal';
import type {
  FakeFacet,
  GatewayWithdrawals,
} from '../../../../../modules/packs/facets';

beforeEach(() => {
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  (refundWithdrawal as jest.Mock).mockClear();
  (applyWithdrawalOutcome as jest.Mock).mockClear();
});

const AUTH = { 'x-public-key': 'pk-test', 'x-secret-key': 'sk-test' };

const success = {
  transactionId: 'tx-9',
  status: 'success',
  amount: 100,
  fee: 1,
  paymentAt: '2026-09-05T12:00:00.000Z',
  orderno: 'tx-9',
  payType: 'PAYOUT',
};

const pendingRow = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-w1',
  gateway_transaction_id: 'tx-9',
  amount: '100',
  bank_code: 'DUMMYBANKVERIFIED',
  account_number: '543478924652',
  account_holder_name: 'Michael Yap',
  status: 'pending',
  failure_reason: null,
  gateway: 'tgpay',
};

function harness(row: Record<string, unknown> | null) {
  const packs = {
    listGatewayWithdrawals: jest.fn().mockResolvedValue(row ? [row] : []),
    updateGatewayWithdrawals: jest.fn().mockResolvedValue(undefined),
  } satisfies FakeFacet<GatewayWithdrawals>;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    body: {},
    headers: { ...AUTH },
    scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
  };
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
  return { packs, logger, req, res };
}

const run = async (
  h: ReturnType<typeof harness>,
  body: Record<string, unknown>,
  headers?: Record<string, unknown>,
) => {
  h.req.body = body;
  if (headers) h.req.headers = headers as never;
  await POST(h.req as never, h.res as never);
  return h.res;
};

describe('tgpay payout callback', () => {
  it('rejects bad key headers with 401 before any lookup', async () => {
    const h = harness(pendingRow);
    const res = await run(h, success, { 'x-public-key': 'pk-test' });
    expect(res.statusCode).toBe(401);
    expect(h.packs.listGatewayWithdrawals).not.toHaveBeenCalled();
  });

  it('finds the row by the GATEWAY id (the body carries no merchantRefNum) and settles it', async () => {
    const h = harness(pendingRow);
    const res = await run(h, success);
    expect(res.statusCode).toBe(200);
    expect(h.packs.listGatewayWithdrawals).toHaveBeenCalledWith(
      { gateway_transaction_id: 'tx-9', gateway: 'tgpay' },
      { take: 1 },
    );
    expect(applyWithdrawalOutcome).toHaveBeenCalledWith(
      h.req.scope,
      pendingRow,
      expect.objectContaining({
        gatewayRef: 'tx-9',
        amountSettled: 100,
        // A payout's net is what the WALLET PAID (plan 133): TGPay charges
        // the fee on top, so a RM 100 payout with a RM 1 fee drains 101. The
        // settlement fee is |gross − net| = 1 either way; the difference is
        // that 101 is the figure the gateway's payout wallet actually moved.
        netAmount: 101,
      }),
    );
    expect(refundWithdrawal).not.toHaveBeenCalled();
  });

  it('falls back to OUR reference when the gateway id is not stored yet, and stores it', async () => {
    const h = harness({ ...pendingRow, gateway_transaction_id: null });
    h.packs.listGatewayWithdrawals
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...pendingRow, gateway_transaction_id: null }]);
    const res = await run(h, { ...success, transactionId: 'PC-w1' });
    expect(res.statusCode).toBe(200);
    expect(h.packs.listGatewayWithdrawals).toHaveBeenLastCalledWith(
      { merchant_transaction_id: 'PC-w1', gateway: 'tgpay' },
      { take: 1 },
    );
    expect(applyWithdrawalOutcome).toHaveBeenCalledWith(
      h.req.scope,
      expect.objectContaining({ id: 'gpw_1' }),
      expect.objectContaining({ gatewayTransactionId: 'PC-w1' }),
    );
  });

  it('a missing fee leaves net unknown (null), never a zero fee', async () => {
    const h = harness(pendingRow);
    await run(h, { ...success, fee: undefined });
    expect(applyWithdrawalOutcome).toHaveBeenCalledWith(
      h.req.scope,
      pendingRow,
      expect.objectContaining({ netAmount: null }),
    );
  });

  it('never touches a row that belongs to another gateway', async () => {
    const h = harness({ ...pendingRow, gateway: 'globepay' });
    const res = await run(h, success);
    expect(res.statusCode).toBe(200);
    expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
    expect(refundWithdrawal).not.toHaveBeenCalled();
  });

  it('a reject refunds through the shared helper, from status pending', async () => {
    const h = harness(pendingRow);
    const res = await run(h, { ...success, status: 'reject' });
    expect(res.statusCode).toBe(200);
    expect(refundWithdrawal).toHaveBeenCalledWith(
      h.req.scope,
      pendingRow,
      null,
      'pending',
      expect.stringMatching(/callback reject/),
    );
    expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
  });

  it('pending is acknowledged and changes nothing', async () => {
    const h = harness(pendingRow);
    const res = await run(h, { ...success, status: 'pending' });
    expect(res.statusCode).toBe(200);
    expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
    expect(refundWithdrawal).not.toHaveBeenCalled();
  });

  it('a replay on a settled row is a no-op, an unknown id is acknowledged', async () => {
    const settled = harness({ ...pendingRow, status: 'settled' });
    expect((await run(settled, success)).statusCode).toBe(200);
    expect(applyWithdrawalOutcome).not.toHaveBeenCalled();

    const unknown = harness(null);
    expect((await run(unknown, success)).statusCode).toBe(200);
    expect(unknown.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/UNKNOWN payout/),
    );
  });

  it('a success on a payout we already refunded alerts ops, with references only', async () => {
    const originalFetch = global.fetch;
    const sent: { chat_id: string; text: string }[] = [];
    process.env.TELEGRAM_BOT_TOKEN = 'bot-test';
    process.env.TELEGRAM_OPS_CHAT_ID = '-100ops';
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    try {
      const h = harness({ ...pendingRow, status: 'failed' });
      const res = await run(h, success);
      expect(res.statusCode).toBe(200);
      expect(applyWithdrawalOutcome).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0].chat_id).toBe('-100ops');
      expect(sent[0].text).toMatch(/PC-w1.*refunded AND paid/);
      expect(sent[0].text).not.toMatch(/543478924652|Michael Yap/);
    } finally {
      global.fetch = originalFetch;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_OPS_CHAT_ID;
    }
  });

  it('a refund failure answers 500 so TGPay retries', async () => {
    (refundWithdrawal as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const h = harness(pendingRow);
    const res = await run(h, { ...success, status: 'reject' });
    expect(res.statusCode).toBe(500);
  });
});
