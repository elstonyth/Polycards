import { requireTurnstile, storefrontHosts } from '../turnstile-guard';

// The human check in front of every paid OTP send. fetch is stubbed: these pin
// what the guard does with each siteverify answer, never Cloudflare itself.

const SECRET = 'turnstile-secret';
const warn = jest.fn();
// Production's STORE_CORS: the storefront's own origins.
const PROD_STORE_CORS =
  'https://polycards-storefront-fzrft.ondigitalocean.app,https://polycards.gg,https://www.polycards.gg';
let storeCors: string;

const makeReq = (body: unknown) =>
  ({
    body,
    scope: {
      resolve: (key: string) => {
        if (key === 'logger') return { warn };
        if (key === 'configModule')
          return { projectConfig: { http: { storeCors } } };
        return undefined;
      },
    },
  }) as never;

// Same stand-in for the framework's wrapHandler as the sibling guard specs:
// a throw and a next(err) land in the same channel.
const run = (req: never) =>
  new Promise<unknown>((resolve) => {
    Promise.resolve(requireTurnstile(req, {} as never, resolve)).catch(resolve);
  });

const siteverify = (status: number, body: unknown) =>
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

/** What a real secret answers for a token the storefront's widget minted. */
const GENUINE = { success: true, action: 'phone-otp', hostname: 'polycards.gg' };

const ORIGINAL = process.env.TURNSTILE_SECRET_KEY;
beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = SECRET;
  storeCors = PROD_STORE_CORS;
  warn.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = ORIGINAL;
});

describe('requireTurnstile', () => {
  it('passes without calling Cloudflare when no secret is configured (ships dark)', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect(await run(makeReq({ phone: '+60123456789' }))).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a request with no token before calling Cloudflare', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const out = await run(makeReq({ phone: '+60123456789', purpose: 'signup' }));
    expect(out).toBeInstanceOf(Error);
    expect(String((out as Error).message)).toMatch(/security check failed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes a token Cloudflare accepts for this action on the storefront', async () => {
    const fetchSpy = siteverify(200, GENUINE);
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const sent = new URLSearchParams(String(init?.body));
    expect(sent.get('secret')).toBe(SECRET);
    expect(sent.get('response')).toBe('tok');
  });

  // A real secret always echoes the widget's action; a token minted by
  // another widget, or one with no action, is not ours.
  it.each([
    ['another action', { ...GENUINE, action: 'login' }],
    ['no action', { success: true, hostname: 'polycards.gg' }],
  ])('refuses %s with the same refusal, and logs why', async (_case, answer) => {
    siteverify(200, answer);
    const out = (await run(
      makeReq({ turnstile_token: 'secret-looking-token' }),
    )) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toMatch(/security check failed/i);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('wrong action');
    expect(line).not.toContain('secret-looking-token');
  });

  it('refuses a token solved on a host that is not the storefront, and logs the host', async () => {
    siteverify(200, { ...GENUINE, hostname: 'elsewhere.example' });
    const out = (await run(
      makeReq({ turnstile_token: 'secret-looking-token' }),
    )) as Error;
    expect(out.message).toMatch(/security check failed/i);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('wrong hostname');
    expect(line).toContain('elsewhere.example');
    expect(line).not.toContain('secret-looking-token');
  });

  it('accepts every storefront host STORE_CORS names', async () => {
    for (const hostname of [
      'www.polycards.gg',
      'polycards-storefront-fzrft.ondigitalocean.app',
    ]) {
      siteverify(200, { ...GENUINE, hostname });
      expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeUndefined();
    }
  });

  // No host list to compare against: only the hostname check steps aside.
  it('skips only the hostname check when STORE_CORS names no host', async () => {
    storeCors = '';
    siteverify(200, { ...GENUINE, hostname: 'elsewhere.example' });
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeUndefined();
    siteverify(200, { ...GENUINE, action: 'login' });
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeInstanceOf(Error);
  });

  // What Cloudflare's published test secret answers (checked against
  // siteverify 2026-10-04): hostname example.com, no action, and a flag that
  // only test secrets set. scripts/qa-phone-otp-turnstile.mjs runs on those keys.
  const TEST_SECRET_ANSWER = {
    success: true,
    hostname: 'example.com',
    metadata: { result_with_testing_key: true },
  };

  it("accepts Cloudflare's test-secret answer outside production", async () => {
    siteverify(200, TEST_SECRET_ANSWER);
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeUndefined();
  });

  // A test secret passes any token, so in production it would switch the
  // human check off. Refused, and named in the log.
  it('refuses the test-secret answer in production', async () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      siteverify(200, TEST_SECRET_ANSWER);
      const out = (await run(makeReq({ turnstile_token: 'tok' }))) as Error;
      expect(out.message).toMatch(/security check failed/i);
      expect(String(warn.mock.calls[0][0])).toContain('test secret in production');
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it('refuses a rejected token and logs only the error codes', async () => {
    siteverify(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await run(makeReq({ turnstile_token: 'secret-looking-token' }))).toBeInstanceOf(Error);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('timeout-or-duplicate');
    expect(line).not.toContain('secret-looking-token');
    expect(line).not.toContain(SECRET);
  });

  // Fail CLOSED: an unreachable siteverify must not reopen the paid send.
  it('refuses when Cloudflare cannot be reached or answers non-2xx', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeInstanceOf(Error);
    siteverify(500, {});
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeInstanceOf(Error);
  });

  it('refuses a non-string or oversized token without calling Cloudflare', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect(await run(makeReq({ turnstile_token: 42 }))).toBeInstanceOf(Error);
    expect(await run(makeReq({ turnstile_token: 'x'.repeat(2049) }))).toBeInstanceOf(Error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('storefrontHosts', () => {
  it('reads the hostnames of the STORE_CORS origins', () => {
    expect(storefrontHosts(PROD_STORE_CORS)).toEqual([
      'polycards-storefront-fzrft.ondigitalocean.app',
      'polycards.gg',
      'www.polycards.gg',
    ]);
    expect(storefrontHosts(' http://localhost:8000 , https://docs.medusajs.com')).toEqual([
      'localhost',
      'docs.medusajs.com',
    ]);
  });

  // Medusa also accepts /regex/ origins; those name no single host.
  it('skips entries that are not URLs, and an empty value names none', () => {
    expect(storefrontHosts('/vercel\\.app$/,https://polycards.gg')).toEqual([
      'polycards.gg',
    ]);
    expect(storefrontHosts('')).toEqual([]);
  });
});
