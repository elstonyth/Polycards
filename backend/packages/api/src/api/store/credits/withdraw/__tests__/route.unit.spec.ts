import { POST } from '../route';

// The IP we send as GlobePay365's `IPAddress` must be the one the proxy chain
// derived, not one the caller typed. Medusa's express-loader sets
// `trust proxy` 1 unconditionally, so req.ip is that value; a raw
// X-Forwarded-For header is attacker-controlled and only a fallback.
//
// This route is the money-OUT direction, so it matters MORE here than on the
// deposit: whatever geo/velocity/AML checks the PSP runs on a payout would
// otherwise be evaluated against an address the payee chose.
jest.mock('../../../../../modules/packs/globepay-withdrawal', () => ({
  startGlobePayWithdrawal: jest.fn(async () => ({ status: 'pending' })),
}));

import { startGlobePayWithdrawal } from '../../../../../modules/packs/globepay-withdrawal';

const startMock = startGlobePayWithdrawal as jest.Mock;

const res = { json: jest.fn() } as never;

const mkReq = (over: Record<string, unknown> = {}) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body: {
      amount: 50,
      bank_code: 'MBB',
      account_number: '1234567890',
      account_holder_name: 'A Customer',
    },
    headers: {},
    scope: {},
    socket: {},
    ...over,
  }) as never;

const sentIp = () => startMock.mock.calls[0][1].ipAddress;

const ORIGINAL_ENV = {
  GLOBEPAY_WITHDRAW_NOTIFY_URL: process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL,
  GLOBEPAY_PAYOUT_VERIFY_URL: process.env.GLOBEPAY_PAYOUT_VERIFY_URL,
};

beforeEach(() => {
  startMock.mockClear();
  process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL =
    'https://us/hooks/globepay/withdrawal';
  process.env.GLOBEPAY_PAYOUT_VERIFY_URL =
    'https://us/hooks/globepay/payout-verify';
});

// These are process-wide: leaving them set leaks into whatever runs next and
// makes a later suite pass or fail on execution order.
afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /store/credits/withdraw — customer IP', () => {
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

  // The header type permits string[] — Node's parser comma-joins repeats and
  // never emits one, but middleware could assign one. Stringifying it would
  // send the gateway '[object Object]' as an IP address.
  it('ignores an array X-Forwarded-For instead of stringifying it', async () => {
    await POST(
      mkReq({
        headers: { 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] },
        socket: { remoteAddress: '10.0.0.1' },
      }),
      res,
    );
    expect(sentIp()).toBe('10.0.0.1');
  });

  // Either URL missing must fail closed: without a NotifyUrl a failed payout
  // could never refund, and without a verify URL their Payout Verification
  // would reject every payout with nothing in our logs explaining why.
  it.each([
    'GLOBEPAY_WITHDRAW_NOTIFY_URL',
    'GLOBEPAY_PAYOUT_VERIFY_URL',
  ] as const)('fails closed when %s is unset', async (missing) => {
    delete process.env[missing];
    await expect(POST(mkReq({ ip: '203.0.113.7' }), res)).rejects.toThrow(
      /not open yet/i,
    );
    expect(startMock).not.toHaveBeenCalled();
  });
});
