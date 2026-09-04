import type {
  AuthenticationInput,
  AuthIdentityProviderService,
} from '@medusajs/framework/types';
import { GoogleAuthWithRetryService } from '../service';

/**
 * Deliberately NOT mocked — the sibling spec replaces `@medusajs/auth-google`
 * wholesale, which means three load-bearing facts about upstream are asserted
 * only by the mock's own fiction: the export name, the `validateCallback`
 * signature, and `logger_`. This spec drives the real class instead, stubbing
 * only the network, so a Medusa bump that moves or reshapes any of them fails
 * here rather than silently in production.
 *
 * `jest.mock` can't be undone within a file, hence the separate spec.
 */

const STATE_KEY = 'oauth-state-under-test';

const request = {
  url: `/auth/customer/google/callback?code=4%2F0Aabc&state=${STATE_KEY}`,
  headers: {},
  query: { code: '4/0Aabc', state: STATE_KEY },
  body: {},
  protocol: 'https',
} as unknown as AuthenticationInput;

/** Single-use, exactly like the auth module's own `getState`. */
const singleUseState = () => {
  let taken = false;
  return jest.fn(async () => {
    if (taken) return null;
    taken = true;
    return { callback_url: 'https://polycards.gg/auth/google/callback' };
  });
};

const identityService = (getState: jest.Mock): AuthIdentityProviderService =>
  ({
    getState,
    setState: jest.fn(),
    retrieve: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  }) as unknown as AuthIdentityProviderService;

const makeService = () => {
  const warn = jest.fn();
  return new GoogleAuthWithRetryService(
    { logger: { warn } } as unknown as ConstructorParameters<
      typeof GoogleAuthWithRetryService
    >[0],
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      callbackUrl: 'https://polycards.gg/auth/google/callback',
    },
  );
};

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('against the real @medusajs/auth-google provider', () => {
  it('retries the token exchange once when undici throws, replaying the state', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    const getState = singleUseState();

    const result = await makeService().validateCallback(
      request,
      identityService(getState),
    );

    // Two POSTs to Google off ONE single-use state read is the whole fix:
    // without the replay wrapper the second pass would never reach fetch, and
    // would report `No state provided, or session expired` instead.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('https://oauth2.googleapis.com/token'),
    );
    expect(result).toEqual({ success: false, error: 'fetch failed' });
  });

  it('does not retry when Google answers with an error status', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    } as Response);

    const result = await makeService().validateCallback(
      request,
      identityService(singleUseState()),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      error: 'Could not exchange token, 400, Bad Request',
    });
  });

  it('still inherits the boot-time options gate', () => {
    expect(() =>
      GoogleAuthWithRetryService.validateOptions(
        {} as Parameters<typeof GoogleAuthWithRetryService.validateOptions>[0],
      ),
    ).toThrow('Google clientId is required');
  });
});
