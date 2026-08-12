import { afterEach, describe, expect, test, vi } from 'vitest';

// __BACKEND_URL__ is injected by the dashboard Vite plugin at build time and is
// only a `declare const` here, so it resolves to a global at runtime. Defining
// it lets the real fetch helpers run in the node test environment.
(globalThis as Record<string, unknown>).__BACKEND_URL__ = 'http://backend.test';

const {
  approveGlobePayWithdrawal,
  denyGlobePayWithdrawal,
  getGlobePayWithdrawalAccount,
  getPurchaseInvoice,
  httpStatus,
} = await import('./admin-rest');

const respondWith = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

// The whole chain the invoice detail page's "not found" copy rests on: the
// response status has to survive from fetch, through the thrown Error, out of
// httpStatus. Asserting httpStatus() on a hand-built object would prove only
// half of it and would still pass if the throw site stopped attaching status.
describe('failed admin-rest calls carry their HTTP status', () => {
  test('a real 404 is reported as 404', async () => {
    respondWith(404, { message: "Purchase invoice 'pinv_x' not found." });
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(httpStatus(err)).toBe(404);
    expect((err as Error).message).toMatch(/not found/i);
  });

  test('a 500 is NOT reported as 404 — the bug this exists to stop', async () => {
    respondWith(500, { message: 'Internal server error' });
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect(httpStatus(err)).toBe(500);
    expect(httpStatus(err)).not.toBe(404);
  });

  test('an unrouted 404 with no JSON body still reports 404', async () => {
    // Task 4 established that an unrouted Medusa 404 carries NO message field,
    // so message-matching cannot distinguish these — only the status can.
    respondWith(404, undefined);
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect((err as Error).message).toBe('Request failed (404).');
    expect(httpStatus(err)).toBe(404);
  });

  test('a transport failure reports NO status, so it cannot read as 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect(httpStatus(err)).toBeUndefined();
  });
});

// The withdrawals list serves account_number MASKED; this is the only client
// call that fetches a full one, and the backend logs and rate-limits it. So it
// must address exactly ONE row — a client that could be talked into a list URL
// would re-derive the bulk view the masking removed.
describe('the withdrawal account reveal fetches one row', () => {
  test('hits the per-id reveal path and returns the full number', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ id: 'gpw_1', account_number: '1234567890' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await getGlobePayWithdrawalAccount('gpw_1');
    expect(out.account_number).toBe('1234567890');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://backend.test/admin/globepay/withdrawals/gpw_1/account',
    );
  });

  test('encodes the id, so it cannot be steered off the single-row path', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: 'x', account_number: '1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getGlobePayWithdrawalAccount('gpw_1/../..?limit=100');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('gpw_1%2F..%2F..%3Flimit%3D100');
    expect(url.endsWith('/account')).toBe(true);
  });

  test('a 404 surfaces its status, so the row-not-found case is distinguishable', async () => {
    respondWith(404, { message: "Withdrawal 'gpw_x' not found." });
    const err = await getGlobePayWithdrawalAccount('gpw_x').catch(
      (e: unknown) => e,
    );
    expect(httpStatus(err)).toBe(404);
  });
});

// Task 6 (plan 094): the admin queue's Approve/Deny buttons. Both routes act
// only on `:id` and the session's admin actor, so there is no meaningful body
// to assert beyond "the right URL, the right method, the response comes
// through unmodified".
describe('the held-withdrawal approve/deny calls', () => {
  test('approve POSTs to ./approve and returns the body verbatim', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'gpw_1',
            status: 'pending',
            transaction_id: 'W2026081200000001',
            approved: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await approveGlobePayWithdrawal('gpw_1');
    expect(out).toEqual({
      id: 'gpw_1',
      status: 'pending',
      transaction_id: 'W2026081200000001',
      approved: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'http://backend.test/admin/globepay/withdrawals/gpw_1/approve',
    );
    expect((init as RequestInit).method).toBe('POST');
  });

  test('deny POSTs to ./deny and returns the body verbatim', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ id: 'gpw_1', status: 'failed', refunded: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await denyGlobePayWithdrawal('gpw_1');
    expect(out).toEqual({ id: 'gpw_1', status: 'failed', refunded: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'http://backend.test/admin/globepay/withdrawals/gpw_1/deny',
    );
    expect((init as RequestInit).method).toBe('POST');
  });

  // A frozen-account refusal, a wrong-status deny, a closed payout channel —
  // every refusal is a thrown MedusaError, and the operator's toast is only
  // as good as this chain surfacing the backend's own message.
  test('a refusal surfaces the backend MedusaError message, not a generic one', async () => {
    respondWith(400, {
      message:
        'This customer’s account is frozen. Unfreeze it before approving a payout, or deny the withdrawal.',
    });
    const err = await approveGlobePayWithdrawal('gpw_1').catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/account is frozen/);
    expect(httpStatus(err)).toBe(400);
  });
});

describe('httpStatus', () => {
  test('ignores anything that is not a numeric status', () => {
    expect(httpStatus(new Error('plain'))).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus(undefined)).toBeUndefined();
    expect(httpStatus('404')).toBeUndefined();
    expect(httpStatus({ status: '404' })).toBeUndefined();
  });
});
