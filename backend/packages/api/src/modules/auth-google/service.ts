import type {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityProviderService,
} from '@medusajs/framework/types';
// Deep import, deliberately: @medusajs/auth-google's package root exports only
// the assembled ModuleProvider, not the service class. The package ships no
// `exports` map (verified against 2.19.x), so the dist path resolves — but that
// is the one thing here a Medusa bump can break. If this import fails after an
// upgrade, the class moved; re-point it rather than reimplementing the flow.
import { GoogleAuthService } from '@medusajs/auth-google/dist/services/google';

/**
 * The exact `Error.message` undici raises when `fetch` produced no response.
 * Usually that is DNS, connect, or TLS failing before anything went out — but
 * undici also raises it for a headers timeout or a socket reset AFTER the
 * request was sent, so it means "we never heard back", not, strictly, "Google
 * never saw it". The distinguishing detail lives in `error.cause`, which the
 * upstream provider discards (it returns only `error.message`), leaving this
 * bare string as the only evidence that the exchange died in transport rather
 * than at Google.
 *
 * Match it EXACTLY. Every other failure `validateCallback` can report is either
 * a longer string or a different one, and none of them may be retried:
 *
 * - `No state provided, or session expired`     — state gone; a retry can't help
 * - `Could not exchange token, 400, Bad Request` — Google ANSWERED; code is spent
 * - `Could not verify Google id_token: fetch failed` — the JWKS fetch failed,
 *   which happens AFTER Google redeemed the code. Re-POSTing it is code reuse,
 *   and RFC 6749 §4.1.2 lets the authorization server revoke the whole grant
 *   for that. Note this one CONTAINS our sentinel — which is precisely why a
 *   substring test would be a security bug and equality is not.
 */
const TRANSPORT_FAILURE = 'fetch failed';

/** See TRANSPORT_FAILURE: equality, never `includes`. */
export const isTransportFailure = (error: unknown): boolean =>
  error === TRANSPORT_FAILURE;

/**
 * `getState` is single-use — the auth module invalidates the cache entry the
 * moment it is read — so a second pass through `validateCallback` would find no
 * state and fail with `No state provided, or session expired`. Hand the provider
 * a view whose `getState` replays the first read instead.
 *
 * A plain spread is enough: `getAuthIdentityProviderService` returns an object
 * literal whose methods are own enumerable properties. Memoizing the PROMISE
 * (not the resolved value) also collapses the second cache round-trip.
 *
 * The memo ignores `key` deliberately — one callback carries exactly one state,
 * and the wrapper is built fresh per `validateCallback`, so a replayed value can
 * never cross requests. It is a replay of THIS read, not a cache.
 */
const withReplayableState = (
  service: AuthIdentityProviderService,
): AuthIdentityProviderService => {
  let pending: Promise<Record<string, unknown> | null> | undefined;
  return {
    ...service,
    getState: (key: string) => (pending ??= service.getState(key)),
  };
};

/**
 * Google auth provider with one retry on a transport failure.
 *
 * Upstream sends the authorization code to Google's token endpoint as a single
 * POST with no retry, so one transient network blip is a dead sign-in for the
 * customer (prod incident 2026-09-04: three consecutive failures inside 33s,
 * `fetch failed` every time, while the pod's egress was otherwise healthy).
 *
 * Retrying a POST is safe in that one case, and only that one. In the common
 * shape — DNS, connect or TLS failed — the request never left, so the code was
 * never redeemed and the retry is Google's FIRST sight of it. In the rarer
 * shape undici also reports as `fetch failed` (a reset or headers timeout after
 * the request went out) Google may already have redeemed the code; the retry
 * then draws `invalid_grant` and, per RFC 6749 §4.1.2, lets Google revoke the
 * grant issued from it. That grant is one we never received a token for, and
 * the sign-in was already lost, so the outcome is unchanged — which is why this
 * residual case is accepted rather than defended against. Telling the two apart
 * needs `error.cause`, and the upstream provider throws it away.
 *
 * Every OTHER failure means the code was demonstrably spent or unusable, so do
 * not widen `isTransportFailure` past exact equality.
 *
 * Retry count is deliberately one, with no delay or backoff: the observed
 * failure was a fast reject (<300ms), where a second attempt either connects or
 * doesn't. Nothing in evidence justifies a policy knob.
 */
export class GoogleAuthWithRetryService extends GoogleAuthService {
  // Keeps the route path (`/auth/customer/google/...`) and every existing
  // `provider_identity.provider` row matching. Changing it orphans them.
  static identifier = 'google';

  async validateCallback(
    req: AuthenticationInput,
    authIdentityService: AuthIdentityProviderService,
  ): Promise<AuthenticationResponse> {
    const replayable = withReplayableState(authIdentityService);

    const first = await super.validateCallback(req, replayable);
    if (!isTransportFailure(first.error)) {
      return first;
    }

    this.logger_.warn(
      '[auth-google] token exchange never reached Google (transport failure) — retrying once',
    );
    return super.validateCallback(req, replayable);
  }
}

export default GoogleAuthWithRetryService;
