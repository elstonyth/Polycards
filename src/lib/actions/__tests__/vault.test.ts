import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same seam as account-lifecycle.test.ts: mock only the boundary modules
// ('use server' actions can't be imported into a non-RSC context otherwise)
// and let the real schema parsing run.
const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  clientFetch: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
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

import { startWithdrawal } from '../vault';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthToken.mockResolvedValue('tok');
  mocks.clientFetch.mockResolvedValue({
    merchantTransactionId: 'PC-W1',
    transactionId: null,
    amount: 50,
    balance: 950,
    status: 'pending',
  });
});

describe('startWithdrawal — Idempotency-Key', () => {
  // PR #427 added optional Idempotency-Key support to
  // POST /store/credits/withdraw; the storefront must actually send it. A
  // server action can reject at the action boundary (offline, 5xx,
  // deployment-id rotation) AFTER the backend already debited and submitted
  // the payout — without a caller-minted key, a UI retry of that same
  // attempt is a second debit and a second bank transfer.
  it('sends the caller-minted key as the Idempotency-Key header', async () => {
    await startWithdrawal({
      amount: 50,
      accountId: 'acct_1',
      idempotencyKey: 'wd-attempt-abc123',
    });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/credits/withdraw',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': 'wd-attempt-abc123',
        }),
      }),
    );
  });

  it('still mints a fallback key when the caller passes none, rather than sending no header at all', async () => {
    await startWithdrawal({ amount: 50, accountId: 'acct_1' });
    const [, opts] = mocks.clientFetch.mock.calls[0]! as [
      string,
      { headers: Record<string, string> },
    ];
    const key = opts.headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key!.length).toBeGreaterThan(0);
  });
});
