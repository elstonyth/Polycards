import { POST } from '../route';

// The IP we send as GlobePay365's `IPAddress` must be the one the proxy chain
// derived, not one the caller typed. Medusa's express-loader sets
// `trust proxy` 1 unconditionally, so req.ip is that value; a raw
// X-Forwarded-For header is attacker-controlled and only a fallback.
jest.mock('../../../../../modules/packs/globepay-deposit', () => ({
  startGlobePayDeposit: jest.fn(async () => ({ url: 'https://cashier/x' })),
}));

import { startGlobePayDeposit } from '../../../../../modules/packs/globepay-deposit';

const startMock = startGlobePayDeposit as jest.Mock;

const res = { json: jest.fn() } as never;

const mkReq = (over: Record<string, unknown> = {}) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body: { amount: 50 },
    headers: {},
    scope: {},
    socket: {},
    ...over,
  }) as never;

const sentIp = () => startMock.mock.calls[0][1].ipAddress;

beforeEach(() => {
  startMock.mockClear();
  process.env.GLOBEPAY_NOTIFY_URL = 'https://us/notify';
  process.env.GLOBEPAY_RETURN_URL = 'https://us/return';
});

describe('POST /store/credits/deposit — customer IP', () => {
  it('prefers req.ip over a spoofable X-Forwarded-For', async () => {
    await POST(
      mkReq({
        ip: '203.0.113.7',
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
        socket: { remoteAddress: '10.0.0.1' },
      }),
      res,
    );
    expect(sentIp()).toBe('203.0.113.7');
  });

  it('falls back to the forwarded first hop, then the socket, then 0.0.0.0', async () => {
    await POST(
      mkReq({ headers: { 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' } }),
      res,
    );
    expect(sentIp()).toBe('1.2.3.4');

    startMock.mockClear();
    await POST(mkReq({ socket: { remoteAddress: '10.0.0.1' } }), res);
    expect(sentIp()).toBe('10.0.0.1');

    startMock.mockClear();
    await POST(mkReq(), res);
    expect(sentIp()).toBe('0.0.0.0');
  });

  it('fails closed when the callback URLs are unset — money in, no credit', async () => {
    delete process.env.GLOBEPAY_NOTIFY_URL;
    await expect(POST(mkReq({ ip: '203.0.113.7' }), res)).rejects.toThrow(
      /temporarily unavailable/i,
    );
    expect(startMock).not.toHaveBeenCalled();
  });
});
