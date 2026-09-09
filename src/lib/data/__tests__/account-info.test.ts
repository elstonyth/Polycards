/**
 * getAccountInfo (src/lib/data/customer.ts) — the one fact the Settings page's
 * delete confirmation branches on.
 *
 * `hasPassword` defaults to TRUE for anything unreadable, and the direction
 * matters: too-true only asks for more proof than needed, while too-false
 * removes the password box from an account that HAS one, and every delete then
 * fails PASSWORD_REQUIRED with no way to comply. That is why the schema makes
 * the field required rather than letting an absent one read as `false`.
 */
import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/store', () => ({ store: storeShim }));
// customer.ts holds the SDK for its sdk.store.customer.* calls; none run here.
vi.mock('@/lib/medusa', () => ({ sdk: { store: { customer: {} } } }));

import { getAccountInfo } from '@/lib/data/customer';

const ACCOUNT = 'GET /store/customers/me/account';

// The pre-feature policy: nothing exempt, nothing blocked. Every fallback
// answers this — a failed read must never lift the phone gate or hide the
// withdrawal form (both are UX; the backend gates enforce).
const NO_POLICY = {
  partner: false,
  withdrawalsBlocked: false,
  verificationExempt: false,
};

describe('getAccountInfo', () => {
  it('reads the route with the customer bearer and passes the answer through', async () => {
    const mem = backend({ [ACCOUNT]: { body: { hasPassword: false } } });
    expect(await getAccountInfo()).toEqual({
      hasPassword: false,
      policy: NO_POLICY,
    });
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/customers/me/account',
      headers: { Authorization: 'Bearer test-token' },
      cache: 'no-store',
    });
  });

  // Partner groups (spec 2026-09-09): the policy block rides on the same
  // read, snake_case on the wire, camelCase for the pages.
  it('passes the partner-group policy through', async () => {
    backend({
      [ACCOUNT]: {
        body: {
          hasPassword: true,
          policy: {
            partner: true,
            withdrawals_blocked: true,
            verification_exempt: true,
          },
        },
      },
    });
    expect(await getAccountInfo()).toEqual({
      hasPassword: true,
      policy: {
        partner: true,
        withdrawalsBlocked: true,
        verificationExempt: true,
      },
    });
  });

  it('defaults to hasPassword: true when logged out, without leaving the storefront', async () => {
    const mem = backend(
      { [ACCOUNT]: { body: { hasPassword: false } } },
      { token: null },
    );
    expect(await getAccountInfo()).toEqual({
      hasPassword: true,
      policy: NO_POLICY,
    });
    expect(mem.requests).toHaveLength(0);
  });

  it('defaults to hasPassword: true on a backend failure', async () => {
    backend({ [ACCOUNT]: { status: 500, body: {} } });
    expect(await getAccountInfo()).toEqual({
      hasPassword: true,
      policy: NO_POLICY,
    });
  });

  it('defaults to hasPassword: true for a body that omits the field', async () => {
    // Pre-port the fetch generic was a type assertion, so this answered
    // `{ hasPassword: undefined }` — falsy, i.e. the DANGEROUS direction.
    backend({ [ACCOUNT]: { body: {} } });
    expect(await getAccountInfo()).toEqual({
      hasPassword: true,
      policy: NO_POLICY,
    });
  });
});
