/**
 * The visitor address the storefront signs onto its backend requests
 * (src/lib/visitor-ip.ts), and the SDK seam that applies it to every call
 * (src/lib/medusa.ts). The backend verifies the pair in
 * backend/packages/api/src/api/utils/visitor-ip.ts; the expected signature is
 * rebuilt here from that wire contract, not imported.
 *
 * The ingress header is mocked the way phone-verification.test.ts does it:
 * `visitor.ip` undefined means no `do-connecting-ip` at all, and `inScope`
 * false means `headers()` throws as it does outside a request (build, cron).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import { createHmac } from 'node:crypto';
import type { FetchArgs } from '@medusajs/js-sdk';

const visitor = vi.hoisted(() => ({
  ip: undefined as string | undefined,
  inScope: true,
  reads: 0,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => {
    visitor.reads++;
    if (!visitor.inScope)
      throw new Error('`headers` was called outside a request scope.');
    return new Headers(visitor.ip ? { 'do-connecting-ip': visitor.ip } : {});
  },
}));

const { withVisitor } = await import('@/lib/visitor-ip');
const { sdk } = await import('@/lib/medusa');

const SECRET = 'visitor-secret';
const ORIGINAL = process.env.STOREFRONT_VISITOR_SECRET;

beforeEach(() => {
  process.env.STOREFRONT_VISITOR_SECRET = SECRET;
  visitor.ip = '175.143.0.1';
  visitor.inScope = true;
  visitor.reads = 0;
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.STOREFRONT_VISITOR_SECRET;
  else process.env.STOREFRONT_VISITOR_SECRET = ORIGINAL;
});

const POST: FetchArgs = { method: 'POST', body: { phone: '+60107667787' } };

/** The pair `withVisitor` added, or undefined when it added nothing. */
const pairOf = (init: FetchArgs | undefined) => {
  const h = init?.headers ?? {};
  return 'x-visitor-ip' in h
    ? { ip: h['x-visitor-ip'], sig: h['x-visitor-sig'] }
    : undefined;
};

describe('withVisitor — the signature', () => {
  it('signs the ingress address with the shared secret and the current second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_900);
    const mac = createHmac('sha256', SECRET)
      .update('175.143.0.1|1760000000')
      .digest('hex');
    expect(pairOf(await withVisitor(POST))).toEqual({
      ip: '175.143.0.1',
      sig: `1760000000.${mac}`,
    });
  });

  it('signs an IPv6 visitor', async () => {
    visitor.ip = '2405:3800:8fa:b723::1';
    expect(pairOf(await withVisitor(POST))?.ip).toBe('2405:3800:8fa:b723::1');
  });

  it('keeps the rest of the request as the caller built it', async () => {
    const init = await withVisitor({
      ...POST,
      headers: { Authorization: 'Bearer t' },
    });
    expect(init?.body).toEqual(POST.body);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  it('always carries the address it signed, whatever the caller set', async () => {
    const init = await withVisitor({
      ...POST,
      headers: { 'x-visitor-ip': '8.8.8.8' },
    });
    expect(pairOf(init)?.ip).toBe('175.143.0.1');
  });

  // Rollout order: the storefront ships first and signs nothing until the
  // secret is set.
  it('adds nothing, and reads no request headers, while the secret is unset', async () => {
    delete process.env.STOREFRONT_VISITOR_SECRET;
    expect(await withVisitor(POST)).toBe(POST);
    expect(visitor.reads).toBe(0);
  });

  it.each([
    ['no ingress header (local dev)', undefined],
    ['a joined list of addresses', '175.143.0.1, 8.8.8.8'],
    ['an address that is not one', 'not-an-ip'],
  ])('adds nothing for %s', async (_, ip) => {
    visitor.ip = ip;
    expect(await withVisitor(POST)).toBe(POST);
  });

  it('adds nothing outside a request scope (build, cron)', async () => {
    visitor.inScope = false;
    expect(await withVisitor(POST)).toBe(POST);
  });
});

describe('withVisitor — which requests are signed', () => {
  it.each(['POST', 'DELETE', 'put'])('signs a %s', async (method) => {
    expect(pairOf(await withVisitor({ method }))).toBeDefined();
  });

  it('signs a read that asked for no-store', async () => {
    expect(
      pairOf(await withVisitor({ method: 'GET', cache: 'no-store' })),
    ).toBeDefined();
  });

  // The Store port's public `cache: 'auto'` loaders send a GET with no cache
  // mode, and they run inside static and ISR renders (src/app/page.tsx) —
  // where merely reading the request's headers turns the route dynamic.
  it.each([
    ['a GET with no cache mode', { method: 'GET' }],
    ['a call with no init at all', undefined],
    ['a force-cache read', { method: 'GET', cache: 'force-cache' as const }],
  ])(
    'leaves %s untouched without reading the request headers',
    async (_, init) => {
      expect(await withVisitor(init)).toBe(init);
      expect(visitor.reads).toBe(0);
    },
  );
});

describe('the SDK client — one seam for every backend call', () => {
  const sent = vi.fn(
    async (_input: unknown, _init: { headers: Headers }) =>
      new Response('{}', { status: 200 }),
  );
  beforeEach(() => {
    sent.mockClear();
    vi.stubGlobal('fetch', sent);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  const headerOf = (call: number, name: string) =>
    sent.mock.calls[call]![1].headers.get(name);

  // resetPassword takes no headers of its own, so only the seam can sign it.
  it('signs sdk.auth.resetPassword', async () => {
    await sdk.auth.resetPassword('customer', 'emailpass', {
      identifier: 'a@x.com',
    });
    expect(headerOf(0, 'x-visitor-ip')).toBe('175.143.0.1');
    expect(headerOf(0, 'x-visitor-sig')).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it('signs a Store-port write, and sends a public read unsigned and unread', async () => {
    await sdk.client.fetch('/store/phone-verification/start', {
      method: 'POST',
      body: {},
      cache: 'no-store',
    });
    await sdk.client.fetch('/store/packs', { method: 'GET' });
    expect(headerOf(0, 'x-visitor-ip')).toBe('175.143.0.1');
    expect(headerOf(1, 'x-visitor-ip')).toBeNull();
    expect(visitor.reads).toBe(1);
  });
});
