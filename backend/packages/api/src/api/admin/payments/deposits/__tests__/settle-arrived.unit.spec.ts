jest.mock('../../../../../modules/packs/settle-arrived', () => ({
  quoteArrivedDeposit: jest.fn(),
  settleArrivedDeposit: jest.fn(),
}));

import {
  quoteArrivedDeposit,
  settleArrivedDeposit,
} from '../../../../../modules/packs/settle-arrived';
import { GET, POST } from '../[id]/settle-arrived/route';

const QUOTE = { depositId: 'gwd_1', ordered: 50, arrived: 40, credit: 167.16 };
const settle = settleArrivedDeposit as jest.Mock;
const quote = quoteArrivedDeposit as jest.Mock;

const mkReq = (body?: unknown) =>
  ({
    params: { id: 'gwd_1' },
    body,
    auth_context: { actor_id: 'user_1' },
    scope: {},
  }) as never;
const mkRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: jest.fn((c: number) => ((res.statusCode = c), res)),
    json: jest.fn((b: unknown) => ((res.body = b), res)),
    setHeader: jest.fn(),
  };
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('settle-arrived route', () => {
  it('GET previews without moving money', async () => {
    quote.mockResolvedValue(QUOTE);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(res.body).toEqual({ quote: QUOTE });
    expect(settle).not.toHaveBeenCalled();
  });

  it('POST needs the RM the operator was shown, and a reason', async () => {
    await expect(
      POST(mkReq({ reason: 'x' }), mkRes() as never),
    ).rejects.toThrow(/expected_credit/);
    await expect(
      POST(mkReq({ expected_credit: 167.16, reason: '  ' }), mkRes() as never),
    ).rejects.toThrow(/reason/);
    await expect(
      POST(
        mkReq({ expected_credit: 167.16, reason: 'r'.repeat(501) }),
        mkRes() as never,
      ),
    ).rejects.toThrow(/reason/);
    expect(settle).not.toHaveBeenCalled();
  });

  it('POST settles with the server-derived admin and the trimmed reason', async () => {
    settle.mockResolvedValue({
      kind: 'settled',
      quote: QUOTE,
      replayed: false,
    });
    const res = mkRes();
    await POST(
      mkReq({ expected_credit: '167.16', reason: ' sent from an exchange ' }),
      res as never,
    );
    expect(settle).toHaveBeenCalledWith(
      {},
      {
        depositId: 'gwd_1',
        expectedCredit: 167.16,
        adminId: 'user_1',
        reason: 'sent from an exchange',
      },
    );
    expect(res.body).toEqual({ settled: true, replayed: false, quote: QUOTE });
  });

  it('answers 409 with the new quote when the record moved', async () => {
    settle.mockResolvedValue({
      kind: 'changed',
      quote: { ...QUOTE, credit: 150 },
    });
    const res = mkRes();
    await POST(mkReq({ expected_credit: 167.16, reason: 'r' }), res as never);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({
      type: 'conflict',
      message: expect.stringContaining('RM 150.00'),
      quote: { credit: 150 },
    });
  });
});
