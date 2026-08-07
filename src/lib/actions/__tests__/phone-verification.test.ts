import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same wholesale-mock shape as auth.test.ts: the real data modules import
// 'server-only' and touch next/headers, so only the action logic runs here.
const mocks = vi.hoisted(() => ({ clientFetch: vi.fn(), logError: vi.fn() }));

vi.mock('@/lib/medusa', () => ({
  sdk: { client: { fetch: mocks.clientFetch } },
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/lib/data/customer', () => ({ getAuthToken: vi.fn() }));

const { startPhoneOtp } = await import('@/lib/actions/phone-verification');

const MY = '+60107667787';
const GB = '+442079460958';

beforeEach(() => {
  mocks.clientFetch.mockReset().mockResolvedValue({});
});

describe('startPhoneOtp — served-destination gate', () => {
  it('sends for a served number', async () => {
    await expect(
      startPhoneOtp({ phone: MY, purpose: 'signup' }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1);
  });

  // The picker only offers MY, but typing a leading `+` overrides it — this is
  // the path that would otherwise reach a backend that refuses in silence.
  it.each(['signup', 'phone-change'] as const)(
    'rejects a typed unserved number for %s, before any request',
    async (purpose) => {
      const result = await startPhoneOtp({ phone: GB, purpose });
      expect(result).toEqual({
        ok: false,
        error:
          'We can only send verification codes to Malaysian (+60) numbers right now.',
      });
      // Never reached the network: no wasted call, and no silent failure.
      expect(mocks.clientFetch).not.toHaveBeenCalled();
    },
  );

  // Exempt for the same reason the backend exempts it — password-reset can only
  // text a number already on an account, and customers whose stored number
  // predates the allowlist must still be able to recover.
  it('lets a password reset through for an unserved number', async () => {
    await expect(
      startPhoneOtp({ phone: GB, purpose: 'password-reset' }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1);
  });

  it('still rejects an unparseable number first', async () => {
    const result = await startPhoneOtp({
      phone: 'nonsense',
      purpose: 'signup',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Please enter a valid phone number for the selected country.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});
