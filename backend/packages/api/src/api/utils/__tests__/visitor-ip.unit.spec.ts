import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  recordVisitorSignal,
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
    // The same address in hex must not collapse every such address into one /64.
    expect(visitorBucket('::ffff:af8f:1')).toBe('175.143.0.1');
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

describe('recordVisitorSignal', () => {
  const DEVICE = '3f2b8c1e-7a4d-4e9a-9c11-5d6e7f8a9b0c';
  const ORIGINAL = process.env.STOREFRONT_VISITOR_SECRET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.STOREFRONT_VISITOR_SECRET;
    else process.env.STOREFRONT_VISITOR_SECRET = ORIGINAL;
    jest.restoreAllMocks();
  });

  const signedHeaders = (
    ip: string,
    seconds = Math.floor(Date.now() / 1000),
  ) => ({
    'x-visitor-ip': ip,
    'x-visitor-sig': `${seconds}.${createHmac('sha256', SECRET).update(`${ip}|${seconds}`).digest('hex')}`,
  });

  const run = (
    headers: Record<string, string>,
    record = jest.fn().mockResolvedValue(undefined),
    actor: string | undefined = 'cus_1',
  ) => {
    process.env.STOREFRONT_VISITOR_SECRET = SECRET;
    const warn = jest.fn();
    const next = jest.fn();
    recordVisitorSignal(
      {
        headers,
        auth_context: { actor_id: actor },
        scope: {
          resolve: (key: string) =>
            key === 'logger' ? { warn } : { recordVisitorSignal: record },
        },
      } as never,
      {} as never,
      next,
    );
    return { record, next, warn };
  };

  it('records a signed visitor with their browser id', () => {
    const { record, next } = run({
      ...signedHeaders('175.143.0.1'),
      'x-visitor-device': DEVICE,
    });
    expect(record).toHaveBeenCalledWith({
      customerId: 'cus_1',
      ip: '175.143.0.1',
      deviceId: DEVICE,
    });
    expect(next).toHaveBeenCalledWith();
  });

  it('stores an IPv6 visitor as their /64', () => {
    const { record } = run(signedHeaders('2001:db8:1:2:3:4:5:6'));
    expect(record.mock.calls[0][0].ip).toBe('2001:db8:1:2::/64');
  });

  it('drops a browser id that is not one of ours', () => {
    const { record } = run({
      ...signedHeaders('175.143.0.1'),
      'x-visitor-device': "x' OR 1=1",
    });
    expect(record.mock.calls[0][0].deviceId).toBeNull();
  });

  it('marks an unsigned request as such, believing nothing it claims', () => {
    const { record, next } = run({
      'x-visitor-ip': '175.143.0.1',
      'x-visitor-device': DEVICE,
    });
    expect(record).toHaveBeenCalledWith({
      customerId: 'cus_1',
      ip: 'unsigned',
      deviceId: null,
    });
    expect(next).toHaveBeenCalledWith();
  });

  it('records nothing while signing is off', () => {
    process.env.STOREFRONT_VISITOR_SECRET = SECRET;
    const record = jest.fn().mockResolvedValue(undefined);
    const next = jest.fn();
    delete process.env.STOREFRONT_VISITOR_SECRET;
    recordVisitorSignal(
      {
        headers: {},
        auth_context: { actor_id: 'cus_1' },
        scope: { resolve: () => ({ recordVisitorSignal: record }) },
      } as never,
      {} as never,
      next,
    );
    expect(record).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('logs no customer details when a write fails', async () => {
    const error = Object.assign(
      new Error('insert values (cus_1, 175.143.0.1) failed'),
      { code: '53300' },
    );
    const { warn } = run(
      signedHeaders('175.143.0.1'),
      jest.fn().mockRejectedValue(error),
    );
    await new Promise((r) => setImmediate(r));
    expect(warn.mock.calls[0][0]).toContain('53300');
    expect(warn.mock.calls[0][0]).not.toContain('175.143.0.1');
    expect(warn.mock.calls[0][0]).not.toContain('cus_1');
  });

  it('is wired after authenticate and the limiter on exactly these routes', () => {
    const entries = extractLimiterEntries(
      readFileSync(MIDDLEWARES_PATH, 'utf8'),
    ).filter((e) => /\brecordVisitorSignal\b/.test(e.middlewares));
    expect(entries.map((e) => e.matcher).sort()).toEqual([
      '/store/credits/withdraw',
      '/store/customers/me/real-name',
      '/store/tasks/*/claim',
      '/store/tasks/checkin',
      '/store/tasks/claims/*',
    ]);
    for (const e of entries) {
      expect(e.methods).toEqual(['POST']);
      expect(e.middlewares.indexOf('authenticate')).toBeLessThan(
        e.middlewares.indexOf('recordVisitorSignal'),
      );
    }
  });

  it('records nothing without a customer', () => {
    const { record, next } = run(signedHeaders('175.143.0.1'), undefined, '');
    expect(record).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('a failed write never costs the customer their request', async () => {
    const { next, warn } = run(
      signedHeaders('175.143.0.1'),
      jest.fn().mockRejectedValue(new Error('db down')),
    );
    expect(next).toHaveBeenCalledWith();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the write', () => {
    const { next } = run(
      signedHeaders('175.143.0.1'),
      jest.fn().mockReturnValue(new Promise(() => {})),
    );
    expect(next).toHaveBeenCalledWith();
  });
});
