import type {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityProviderService,
} from '@medusajs/framework/types';

// The upstream provider is mocked at the module boundary so these tests never
// reach Google, and so the base `validateCallback` can be scripted per case.
// The spy is created INSIDE the factory because jest hoists jest.mock above the
// surrounding declarations — a `const` referenced from the factory would be in
// its TDZ.
jest.mock('@medusajs/auth-google/dist/services/google', () => {
  const validateCallback = jest.fn();
  class GoogleAuthService {
    protected logger_: { warn: (message: string) => void };
    constructor(deps: { logger: { warn: (message: string) => void } }) {
      this.logger_ = deps.logger;
    }
    async validateCallback(
      req: unknown,
      authIdentityService: unknown,
    ): Promise<unknown> {
      return validateCallback(req, authIdentityService);
    }
  }
  return { GoogleAuthService, __validateCallback: validateCallback };
});

const { __validateCallback: baseValidateCallback } = jest.requireMock(
  '@medusajs/auth-google/dist/services/google',
) as { __validateCallback: jest.Mock };

import {
  GoogleAuthWithRetryService,
  isTransportFailure,
} from '../service';

const STATE_KEY = 'oauth-state-under-test';
const STORED_STATE = {
  callback_url: 'https://polycards.gg/auth/google/callback',
};
const TRANSPORT_FAILURE_RESPONSE: AuthenticationResponse = {
  success: false,
  error: 'fetch failed',
};
const SUCCESS = {
  success: true,
  authIdentity: { id: 'authid_01' },
} as unknown as AuthenticationResponse;

const request = {
  url: `/auth/customer/google/callback?code=4%2F0Aabc&state=${STATE_KEY}`,
  headers: {},
  query: { code: '4/0Aabc', state: STATE_KEY },
  body: {},
  protocol: 'https',
} as unknown as AuthenticationInput;

/**
 * A faithful stand-in for the real auth module's `getState`: single-use, so the
 * second read returns null. Without the service's replay wrapper a retry would
 * see nothing here — which is exactly what these tests have to prove it doesn't.
 */
const singleUseState = (value: Record<string, unknown> | null) => {
  let taken = false;
  return jest.fn(async () => {
    if (taken) return null;
    taken = true;
    return value;
  });
};

const identityService = (
  getState: AuthIdentityProviderService['getState'],
): AuthIdentityProviderService =>
  ({
    getState,
    setState: jest.fn(),
    retrieve: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  }) as unknown as AuthIdentityProviderService;

/**
 * Scripts the base provider one response per attempt, but reads state first so
 * a consumed state surfaces the real upstream message instead of the script.
 */
const scriptBase = (...responses: AuthenticationResponse[]) => {
  const queue = [...responses];
  baseValidateCallback.mockImplementation(
    async (_req: AuthenticationInput, svc: AuthIdentityProviderService) => {
      const state = await svc.getState(STATE_KEY);
      if (!state) {
        return { success: false, error: 'No state provided, or session expired' };
      }
      return queue.shift() ?? SUCCESS;
    },
  );
};

const makeService = () => {
  const warn = jest.fn();
  const service = new GoogleAuthWithRetryService(
    { logger: { warn } } as unknown as ConstructorParameters<
      typeof GoogleAuthWithRetryService
    >[0],
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      callbackUrl: 'https://polycards.gg/auth/google/callback',
    },
  );
  return { service, warn };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isTransportFailure', () => {
  it('matches only undici’s bare transport message', () => {
    expect(isTransportFailure('fetch failed')).toBe(true);
  });

  // The security argument in one table. Each of these is a message the upstream
  // provider can return, and every one of them means the authorization code was
  // either already redeemed or never usable — retrying re-POSTs a spent code,
  // which RFC 6749 §4.1.2 lets Google revoke the whole grant over.
  it.each([
    'No code provided',
    'No state provided, or session expired',
    'Could not exchange token, 400, Bad Request',
    'Could not exchange token, 401, Unauthorized',
    'Email not verified, cannot proceed with authentication',
    "id_token is missing 'sub' claim",
    'No ID found',
    // Contains the sentinel as a SUBSTRING and must still not retry: the JWKS
    // fetch fails only after Google has already redeemed the code. This case is
    // what fails if someone loosens the check to `.includes(...)`.
    'Could not verify Google id_token: fetch failed',
  ])('does not match %p', (message) => {
    expect(isTransportFailure(message)).toBe(false);
  });

  it('does not match a success (no error at all)', () => {
    expect(isTransportFailure(undefined)).toBe(false);
  });
});

describe('GoogleAuthWithRetryService.validateCallback', () => {
  it('passes a success straight through without retrying', async () => {
    scriptBase(SUCCESS);
    const { service, warn } = makeService();

    const result = await service.validateCallback(
      request,
      identityService(singleUseState(STORED_STATE)),
    );

    expect(result).toEqual(SUCCESS);
    expect(baseValidateCallback).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    'No state provided, or session expired',
    'Could not exchange token, 400, Bad Request',
    'Could not verify Google id_token: fetch failed',
  ])('does not retry after %p', async (error) => {
    scriptBase({ success: false, error });
    const { service, warn } = makeService();

    const result = await service.validateCallback(
      request,
      identityService(singleUseState(STORED_STATE)),
    );

    expect(result).toEqual({ success: false, error });
    expect(baseValidateCallback).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries once on a transport failure and replays the single-use state', async () => {
    scriptBase(TRANSPORT_FAILURE_RESPONSE, SUCCESS);
    const getState = singleUseState(STORED_STATE);
    const { service, warn } = makeService();

    const result = await service.validateCallback(
      request,
      identityService(getState),
    );

    // The retry succeeded, which is only possible if the second pass saw the
    // state — the underlying single-use read was consumed by the first pass.
    expect(result).toEqual(SUCCESS);
    expect(baseValidateCallback).toHaveBeenCalledTimes(2);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry rather than looping', async () => {
    scriptBase(TRANSPORT_FAILURE_RESPONSE, TRANSPORT_FAILURE_RESPONSE, SUCCESS);
    const { service } = makeService();

    const result = await service.validateCallback(
      request,
      identityService(singleUseState(STORED_STATE)),
    );

    expect(result).toEqual(TRANSPORT_FAILURE_RESPONSE);
    expect(baseValidateCallback).toHaveBeenCalledTimes(2);
  });

  it('keeps the provider id so existing provider_identity rows still match', () => {
    expect(GoogleAuthWithRetryService.identifier).toBe('google');
  });
});
