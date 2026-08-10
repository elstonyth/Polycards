import {
  noStoreForAuthenticatedAdmin,
  noStoreForAuthenticatedStore,
} from '../cache-headers';

// The whole contract is the gate: set the header for a verified customer, and
// for nobody else. Getting it wrong in the permissive direction would make the
// public catalog uncacheable; getting it wrong in the strict direction would
// let a per-customer response sit in a cache (CWE-525).
const mkRes = () => {
  const headers: Record<string, string> = {};
  return {
    res: {
      setHeader: (k: string, v: string) => (headers[k] = v),
    } as never,
    headers,
  };
};

describe('noStoreForAuthenticatedStore', () => {
  it('marks a verified customer response no-store', () => {
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedStore(
      { auth_context: { actor_id: 'cus_1', actor_type: 'customer' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBe('no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves anonymous store traffic cacheable', () => {
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedStore({} as never, res, next);

    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-customer actor', () => {
    // An admin bearer reaching a /store path is not the customer data this
    // guards, and should not silently change caching for admin tooling.
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedStore(
      { auth_context: { actor_id: 'usr_1', actor_type: 'user' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores an auth_context with no actor_id', () => {
    // The framework populates an EMPTY auth_context on anonymous store traffic
    // (allowUnauthenticated), so the actor_id check — not mere presence of the
    // object — is what separates a real customer from a public request.
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedStore(
      { auth_context: { actor_id: '', actor_type: 'customer' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('noStoreForAuthenticatedAdmin', () => {
  // The actor types are not guessed: @medusajs/framework's router mounts
  // `app.use('/admin', authenticate('user', ['bearer','session','api-key']))`
  // (dist/http/router.js:89), and that middleware writes actor_type 'user' for
  // a session/JWT admin and 'api-key' for a secret-API-key caller
  // (dist/http/middlewares/authenticate-middleware.js:21-26).
  it('marks a session/JWT admin response no-store', () => {
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedAdmin(
      { auth_context: { actor_id: 'usr_1', actor_type: 'user' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBe('no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('marks a secret-API-key admin response no-store', () => {
    // The one admin actor type that is NOT 'user'. Covering only 'user' would
    // leave this path header-less — the same per-case gap the blanket matcher
    // exists to close.
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedAdmin(
      { auth_context: { actor_id: 'apk_1', actor_type: 'api-key' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBe('no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves a request with no auth_context alone', () => {
    // /admin has no allowUnauthenticated, so the framework 401s before this
    // runs — except on an AUTHENTICATE=false route (core's
    // /admin/feature-flags, /admin/invites/accept), which serves no
    // identity-bound data. Mirrors the store version's anonymous passthrough.
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedAdmin({} as never, res, next);

    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores a customer actor', () => {
    // Keeps the two middlewares independent: the store guard owns customer
    // traffic, this one owns admin traffic, and neither reaches across.
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedAdmin(
      { auth_context: { actor_id: 'cus_1', actor_type: 'customer' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores an auth_context with no actor_id', () => {
    const { res, headers } = mkRes();
    const next = jest.fn();

    noStoreForAuthenticatedAdmin(
      { auth_context: { actor_id: '', actor_type: 'user' } } as never,
      res,
      next,
    );

    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
