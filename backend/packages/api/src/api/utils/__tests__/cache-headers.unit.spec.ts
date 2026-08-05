import { noStoreForAuthenticatedStore } from '../cache-headers';

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
