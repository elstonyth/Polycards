import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  requireVouchedVisitor,
  visitorBucket,
  vouchedVisitorIp,
} from '../visitor-ip';
import {
  MIDDLEWARES_PATH,
  extractLimiterEntries,
} from '../../__tests__/rate-limit-coverage-helpers';

// The visitor address the storefront signs onto its backend requests
// (src/lib/visitor-ip.ts in the storefront). The pair is rebuilt here from the
// wire contract rather than imported, so the two apps cannot drift apart
// without this spec failing.

const SECRET = 'visitor-secret';
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

const signed = (ip: string, ts = NOW_S, secret = SECRET) => ({
  'x-visitor-ip': ip,
  'x-visitor-sig': `${ts}.${createHmac('sha256', secret)
    .update(`${ip}|${ts}`)
    .digest('hex')}`,
});

const ORIGINAL = process.env.STOREFRONT_VISITOR_SECRET;
beforeEach(() => {
  process.env.STOREFRONT_VISITOR_SECRET = SECRET;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.STOREFRONT_VISITOR_SECRET;
  else process.env.STOREFRONT_VISITOR_SECRET = ORIGINAL;
});

const vouched = (headers?: Record<string, string | string[] | undefined>) =>
  vouchedVisitorIp({ headers }, NOW_MS);

describe('vouchedVisitorIp', () => {
  it.each(['175.143.0.1', '2405:3800:8fa:b723::1'])(
    'returns the address of a valid pair (%s)',
    (ip) => {
      expect(vouched(signed(ip))).toBe(ip);
    },
  );

  it('accepts a timestamp up to five minutes either side of now', () => {
    expect(vouched(signed('175.143.0.1', NOW_S - 300))).toBe('175.143.0.1');
    expect(vouched(signed('175.143.0.1', NOW_S + 300))).toBe('175.143.0.1');
  });

  it('refuses a stale or a future timestamp', () => {
    expect(vouched(signed('175.143.0.1', NOW_S - 301))).toBeNull();
    expect(vouched(signed('175.143.0.1', NOW_S + 301))).toBeNull();
  });

  it('returns null for a request with no pair', () => {
    expect(vouched({})).toBeNull();
    expect(vouched(undefined)).toBeNull();
    expect(vouched({ 'x-visitor-ip': '175.143.0.1' })).toBeNull();
  });

  it('refuses a pair signed with another secret', () => {
    expect(vouched(signed('175.143.0.1', NOW_S, 'other-secret'))).toBeNull();
  });

  it('refuses a pair whose address was changed after signing', () => {
    expect(
      vouched({ ...signed('175.143.0.1'), 'x-visitor-ip': '175.143.0.2' }),
    ).toBeNull();
  });

  it.each([
    ['no timestamp', 'deadbeef'],
    ['a bare timestamp', `${NOW_S}`],
    ['a short digest', `${NOW_S}.abc123`],
    ['a non-hex digest', `${NOW_S}.${'zz'.repeat(32)}`],
    ['a non-numeric timestamp', `soon.${'ab'.repeat(32)}`],
    ['a trailing field', `${signed('175.143.0.1')['x-visitor-sig']}.x`],
  ])('refuses a signature with %s', (_, sig) => {
    expect(
      vouched({ 'x-visitor-ip': '175.143.0.1', 'x-visitor-sig': sig }),
    ).toBeNull();
  });

  // Signed with the right secret, so only the address check can refuse these.
  it.each(['not-an-ip', '175.143.0.1, 8.8.8.8', ''])(
    'refuses an address that is not exactly one IP (%j)',
    (ip) => {
      expect(vouched(signed(ip))).toBeNull();
    },
  );

  it('refuses a repeated header', () => {
    const pair = signed('175.143.0.1');
    expect(
      vouched({ ...pair, 'x-visitor-ip': ['175.143.0.1', '175.143.0.1'] }),
    ).toBeNull();
  });

  // Rollout order: until the backend has the secret, nothing is vouched and
  // every request keys exactly as it did before signing existed.
  it('vouches for nothing while the secret is unset', () => {
    delete process.env.STOREFRONT_VISITOR_SECRET;
    expect(vouched(signed('175.143.0.1'))).toBeNull();
  });
});

describe('visitorBucket', () => {
  it('keys an IPv4 address on itself, unwrapping the IPv4-mapped form', () => {
    expect(visitorBucket('175.143.0.1')).toBe('175.143.0.1');
    expect(visitorBucket('::ffff:175.143.0.1')).toBe('175.143.0.1');
  });

  // One subscriber is normally handed a whole /64, and the device picks the
  // low 64 bits itself — so every address inside one /64 is one visitor.
  it('keys every address in one IPv6 /64 on that /64', () => {
    const bucket = '2405:3800:8fa:b723::/64';
    expect(visitorBucket('2405:3800:8fa:b723::1')).toBe(bucket);
    expect(visitorBucket('2405:3800:08FA:B723:abcd:1234:5678:9abc')).toBe(
      bucket,
    );
    expect(visitorBucket('2405:3800:8fa:b724::1')).not.toBe(bucket);
  });

  it('expands a compressed prefix before cutting it', () => {
    expect(visitorBucket('2405::1')).toBe('2405:0:0:0::/64');
    expect(visitorBucket('::1')).toBe('0:0:0:0::/64');
    expect(visitorBucket('2405:3800::b723:0:0:1')).toBe('2405:3800:0:0::/64');
  });
});

describe('requireVouchedVisitor', () => {
  const warn = jest.fn();
  const makeReq = (headers: Record<string, string> = {}) =>
    ({
      headers,
      scope: {
        resolve: (key: string) => (key === 'logger' ? { warn } : undefined),
      },
    }) as never;
  const run = (req: never) =>
    new Promise<unknown>((resolve) => {
      requireVouchedVisitor(req, {} as never, resolve);
    });

  beforeEach(() => {
    warn.mockClear();
    jest.useFakeTimers({ now: NOW_MS });
  });
  afterEach(() => jest.useRealTimers());

  it('steps aside while the secret is unset (rollout order)', async () => {
    delete process.env.STOREFRONT_VISITOR_SECRET;
    expect(await run(makeReq())).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a request the storefront signed', async () => {
    expect(await run(makeReq(signed('175.143.0.1')))).toBeUndefined();
  });

  it('refuses an unsigned request with a neutral message', async () => {
    const out = await run(makeReq());
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe(
      'Please request your code from polycards.gg.',
    );
  });

  it.each([
    ['missing', {}],
    ['malformed', { 'x-visitor-ip': '175.143.0.1', 'x-visitor-sig': 'x' }],
    ['stale', signed('175.143.0.1', NOW_S - 301)],
    ['mismatch', signed('175.143.0.1', NOW_S, 'other-secret')],
  ])('logs why a %s pair was refused', async (why, headers) => {
    expect(await run(makeReq(headers))).toBeInstanceOf(Error);
    expect(String(warn.mock.calls[0][0])).toContain(`(${why})`);
  });

  it('never logs the signature or the secret', async () => {
    const pair = signed('175.143.0.1', NOW_S, 'other-secret');
    await run(makeReq(pair));
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain(pair['x-visitor-sig']);
    expect(line).not.toContain(SECRET);
  });

  // Only the OTP start route refuses an unsigned request. The admin and
  // vendor dashboards, scripts and every other route are served without one.
  it('runs first on the OTP start route, and on no other route', () => {
    const entries = extractLimiterEntries(
      readFileSync(MIDDLEWARES_PATH, 'utf8'),
    ).filter((e) => /\brequireVouchedVisitor\b/.test(e.middlewares));
    expect(entries.map((e) => [e.matcher, e.methods])).toEqual([
      ['/store/phone-verification/start', ['POST']],
    ]);
    expect(entries[0].middlewares.trim()).toMatch(/^requireVouchedVisitor,/);
  });
});
