import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real data modules import 'server-only' (throws outside an RSC) and touch
// next/headers — mock them wholesale so only the action logic under test runs.
const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
  clientFetch: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
  clearAuthToken: mocks.clearAuthToken,
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/lib/medusa', () => ({
  sdk: { client: { fetch: mocks.clientFetch } },
}));

import {
  disableAccount,
  reactivateAccount,
  deleteAccount,
} from '../account-lifecycle';
import { DELETE_LINK } from '../account-lifecycle-map';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthToken.mockResolvedValue('tok');
  mocks.clientFetch.mockResolvedValue({});
});

/** Must match GENERIC in the action — the copy shown when nothing is known. */
const GENERIC = 'Something went wrong. Please try again.';

describe('disableAccount', () => {
  it('calls the route and clears the session cookie', async () => {
    await expect(disableAccount()).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/disable',
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
    expect(mocks.clearAuthToken).toHaveBeenCalled();
  });

  // The cookie must survive a failure, or a customer whose disable errored is
  // logged out with the account still active and no way to see what happened.
  it('keeps the cookie when the backend refuses', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('boom'));
    const r = await disableAccount();
    expect(r.ok).toBe(false);
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });

  it('refuses when logged out', async () => {
    mocks.getAuthToken.mockResolvedValue(undefined);
    await expect(disableAccount()).resolves.toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});

describe('reactivateAccount', () => {
  it('posts to the reactivate route', async () => {
    await expect(reactivateAccount()).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/reactivate',
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
    // The cookie MUST survive here — unlike disable and delete, this is the one
    // success path the customer carries straight on through. Clearing it would
    // log them out the instant they reactivated, which is the exact opposite of
    // what the flow is for.
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });

  // The backend answers 200 `{ disabled: false }` WITHOUT writing when the
  // account is not disabled at all — an admin can re-enable between the login
  // attempt and the customer confirming the prompt. That is a success, and the
  // action must not inspect the body looking for proof a write happened.
  it('treats an already-active account as success', async () => {
    mocks.clientFetch.mockResolvedValue({ disabled: false });
    await expect(reactivateAccount()).resolves.toEqual({ ok: true });
  });

  // The branch the login prompt actually depends on: a failed reactivation has
  // to come back as a message the prompt can show, not as a thrown action.
  it('reports a failure instead of throwing', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('boom'));
    const r = await reactivateAccount();
    expect(r.ok).toBe(false);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('refuses when logged out', async () => {
    mocks.getAuthToken.mockResolvedValue(undefined);
    await expect(reactivateAccount()).resolves.toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});

describe('deleteAccount', () => {
  it('sends the password and clears the cookie on success', async () => {
    await expect(deleteAccount('pw')).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/delete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: { password: 'pw' },
      },
    );
    expect(mocks.clearAuthToken).toHaveBeenCalled();
  });

  it('omits the password entirely for a Google-only account', async () => {
    await deleteAccount(null);
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/delete',
      { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: {} },
    );
  });

  // The blocked-balance copy must NOT simply say "withdraw it". The playthrough
  // gate locks a deposit that was never spent on a pack, so a customer who
  // deposited and never opened anything cannot withdraw at all — that advice
  // would be a dead end. Blocking is right (deleting would strand the money),
  // so the copy names support as the other way out.
  it('surfaces the machine-readable reason and keeps the cookie', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('BALANCE_NOT_ZERO'));
    const r = await deleteAccount('pw');
    expect(r).toEqual({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      error:
        'Your wallet still holds a balance. Withdraw it first — or contact support if it cannot be withdrawn yet.',
    });
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });

  // ACCOUNT_FROZEN is checked FIRST by the backend preflight and is orthogonal
  // to `disabled`, so it reaches the modal on an otherwise healthy session. It
  // was added late to the reason union and is the easiest one to leave unmapped.
  it('maps a frozen account to its own copy', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('ACCOUNT_FROZEN'));
    const r = await deleteAccount('pw');
    expect(r).toMatchObject({
      ok: false,
      reason: 'ACCOUNT_FROZEN',
      error: 'This account is under review. Please contact support.',
    });
  });

  it('maps a wrong password to its own copy', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('PASSWORD_INCORRECT'));
    const r = await deleteAccount('pw');
    expect(r).toMatchObject({
      ok: false,
      reason: 'PASSWORD_INCORRECT',
      error: 'That password is incorrect.',
    });
  });

  // Every row of DELETE_COPY, driven through the public action.
  //
  // DELETE_COPY cannot be exported and asserted directly the way DELETE_LINK is:
  // account-lifecycle.ts carries 'use server' and may only export async
  // functions. So the codes are duplicated here, and each is required to produce
  // its OWN sentence — deleting any row would drop it through to GENERIC, which
  // on a real-money path means telling a customer nothing about why their
  // deletion was refused. Exact wording for the three that carry a deliberate
  // decision is pinned separately below.
  it.each([
    'PASSWORD_REQUIRED',
    'PASSWORD_INCORRECT',
    'ACCOUNT_FROZEN',
    'BALANCE_NOT_ZERO',
    'WITHDRAWAL_PENDING',
    'DEPOSIT_PENDING',
    'CARDS_UNSETTLED',
    'DELIVERY_IN_FLIGHT',
  ])('gives %s its own actionable copy', async (code) => {
    mocks.clientFetch.mockRejectedValue(new Error(code));
    const r = await deleteAccount('pw');
    if (r.ok) throw new Error(`expected ${code} to be refused`);
    expect(r.reason).toBe(code);
    expect(r.error).not.toBe(GENERIC);
    expect(r.error.length).toBeGreaterThan(0);
  });

  it('falls back cleanly on an unrecognised failure', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('kaboom'));
    const r = await deleteAccount('pw');
    // `error` is asserted, not just the shape: the whole point of the fallback
    // is that an unmapped future code renders SOMETHING, and a shape-only
    // assertion would happily pass while it rendered an empty string.
    expect(r).toEqual({ ok: false, reason: null, error: GENERIC });
  });

  // DeleteResult carries `reason` on every failure shape; the logged-out branch
  // is the one that has no error to read a code from.
  it('refuses when logged out', async () => {
    mocks.getAuthToken.mockResolvedValue(undefined);
    await expect(deleteAccount('pw')).resolves.toEqual({
      ok: false,
      error: 'Please log in first.',
      reason: null,
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});

// The two maps are maintained by hand because DeleteBlockReason lives in the
// backend package and cannot be imported across the boundary. This pins the
// half that a compiler cannot: every blocker the customer must leave the modal
// to clear has somewhere to go. The password codes are fixed in the modal
// itself, so they are deliberately absent.
describe('DELETE_LINK', () => {
  it('routes every off-modal blocker and no password code', async () => {
    expect(Object.keys(DELETE_LINK).sort()).toEqual([
      'ACCOUNT_FROZEN',
      'BALANCE_NOT_ZERO',
      'CARDS_UNSETTLED',
      'DELIVERY_IN_FLIGHT',
      'DEPOSIT_PENDING',
      'WITHDRAWAL_PENDING',
    ]);
  });

  // Shape only — that each entry is a usable root-relative href with a label.
  // Existence was verified by hand against src/app when these were written
  // (all six resolve under the (account) route group, plus /contact); nothing
  // here would catch a later route rename, so re-check by hand if you move one.
  it('gives every entry a root-relative href and a label', () => {
    for (const { href, label } of Object.values(DELETE_LINK)) {
      expect(href).toMatch(/^\/[a-z]/);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
