import { requireTurnstile } from '../turnstile-guard';

// The human check in front of every paid OTP send. fetch is stubbed: these pin
// what the guard does with each siteverify answer, never Cloudflare itself.

const SECRET = 'turnstile-secret';
const warn = jest.fn();

const makeReq = (body: unknown) =>
  ({
    body,
    scope: { resolve: (key: string) => (key === 'logger' ? { warn } : undefined) },
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

const ORIGINAL = process.env.TURNSTILE_SECRET_KEY;
beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = SECRET;
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

  it('passes a token Cloudflare accepts for this action', async () => {
    const fetchSpy = siteverify(200, { success: true, action: 'phone-otp' });
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const sent = new URLSearchParams(String(init?.body));
    expect(sent.get('secret')).toBe(SECRET);
    expect(sent.get('response')).toBe('tok');
  });

  // Cloudflare's testing secrets answer without an `action`; a real key always
  // echoes the widget's. A token minted for another action is not ours.
  it('accepts an answer with no action (testing keys) but refuses another action', async () => {
    siteverify(200, { success: true });
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeUndefined();
    siteverify(200, { success: true, action: 'login' });
    expect(await run(makeReq({ turnstile_token: 'tok' }))).toBeInstanceOf(Error);
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
