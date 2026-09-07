import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The actions import the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). Nothing
// beneath the port (SDK, cookies, logger) is mocked — the real schema parsing
// and copy tables run.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import {
  getVault,
  sellBackPull,
  startWithdrawal,
  topUpCredits,
} from '../vault';

const WITHDRAW_OK = {
  body: {
    merchantTransactionId: 'PC-W1',
    transactionId: null,
    amount: 50,
    balance: 950,
    status: 'pending',
  },
};

describe('startWithdrawal — Idempotency-Key', () => {
  // PR #427 added optional Idempotency-Key support to
  // POST /store/credits/withdraw; the storefront must actually send it. A
  // server action can reject at the action boundary (offline, 5xx,
  // deployment-id rotation) AFTER the backend already debited and submitted
  // the payout — without a caller-minted key, a UI retry of that same
  // attempt is a second debit and a second bank transfer.
  it('sends the caller-minted key as the Idempotency-Key header', async () => {
    const mem = backend({ 'POST /store/credits/withdraw': WITHDRAW_OK });
    await startWithdrawal({
      amount: 50,
      accountId: 'acct_1',
      idempotencyKey: 'wd-attempt-abc123',
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/credits/withdraw',
      headers: { 'Idempotency-Key': 'wd-attempt-abc123' }, // gitleaks:allow — synthetic test dedupe tag, not a credential
      body: { amount: 50, account_id: 'acct_1' },
    });
  });

  it('still mints a fallback key when the caller passes none, rather than sending no header at all', async () => {
    const mem = backend({ 'POST /store/credits/withdraw': WITHDRAW_OK });
    await startWithdrawal({ amount: 50, accountId: 'acct_1' });
    const key = mem.requests[0]?.headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key!.length).toBeGreaterThan(0);
  });

  it('maps the response: our reference while the submit is still resolving, pending by default', async () => {
    backend({ 'POST /store/credits/withdraw': WITHDRAW_OK });
    expect(await startWithdrawal({ amount: 50, accountId: 'acct_1' })).toEqual({
      ok: true,
      amount: 50,
      balance: 950,
      reference: 'PC-W1',
      status: 'pending',
    });
  });
});

describe('topUpCredits — Idempotency-Key', () => {
  // Mandatory since the 2026-07-07 audit: the key is minted once per top-up
  // ATTEMPT by the caller (TopUpSheet) and replayed across retries of that
  // attempt, so a credited-but-response-lost retry dedupes on the backend
  // instead of double-crediting.
  it('posts the amount with the caller-minted key as the Idempotency-Key header', async () => {
    const mem = backend({
      'POST /store/credits/topup': { body: { amount: 25, balance: 125 } },
    });
    expect(await topUpCredits(25, 'topup-attempt-abc123')).toEqual({
      ok: true,
      amount: 25,
      balance: 125,
      replayed: false,
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/credits/topup',
      headers: { 'Idempotency-Key': 'topup-attempt-abc123' },
      body: { amount: 25 },
    });
  });

  it('still mints a fallback key when the caller passes none, rather than sending no header at all', async () => {
    const mem = backend({
      'POST /store/credits/topup': { body: { amount: 25, balance: 125 } },
    });
    await topUpCredits(25);
    const key = mem.requests[0]?.headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key!.length).toBeGreaterThan(0);
  });

  it('reports a backend replay so the sheet does not claim a second charge', async () => {
    backend({
      'POST /store/credits/topup': {
        body: { amount: 25, balance: 125, replayed: true },
      },
    });
    expect(await topUpCredits(25, 'k')).toEqual({
      ok: true,
      amount: 25,
      balance: 125,
      replayed: true,
    });
  });
});

describe('getVault', () => {
  const ITEM = {
    pull_id: 'pull_1',
    card: { name: 'Pikachu' },
    buyback: { amount: 10, percent: 50 },
  };

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await getVault()).toEqual({
      ok: false,
      error: 'Please log in to view your vault.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  it('lists the vault with the balance; a balance that fails its schema reads as 0, never an error', async () => {
    backend({
      'GET /store/vault': { body: { items: [ITEM, { pull_id: 'broken' }] } },
      'GET /store/credits/balance': { body: { balance: 'lots' } },
    });
    const r = await getVault();
    expect(r.ok && r.items.map((i) => i.pullId)).toEqual(['pull_1']);
    expect(r.ok && r.balance).toBe(0);
  });

  it('a backend refusal maps through the vault copy table', async () => {
    backend({
      'GET /store/vault': { status: 429 },
      'GET /store/credits/balance': { body: { balance: 1 } },
    });
    expect(await getVault()).toEqual({
      ok: false,
      error: 'Too many requests — give it a moment and try again.',
      needsAuth: false,
    });
  });
});

describe('sellBackPull', () => {
  it('posts an empty body to the buyback route and maps the credit', async () => {
    const mem = backend({
      'POST /store/vault/:id/buyback': {
        body: { amount: 12.5, balance: 100 },
      },
    });
    expect(await sellBackPull('pull_1')).toEqual({
      ok: true,
      amount: 12.5,
      percent: 0,
      balance: 100,
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/vault/pull_1/buyback',
      body: {},
    });
  });

  it('a 401 from the backend reopens the login sheet with the vault copy', async () => {
    backend({ 'POST /store/vault/:id/buyback': { status: 401 } });
    expect(await sellBackPull('pull_1')).toEqual({
      ok: false,
      error: 'Please log in to view your vault.',
      needsAuth: true,
    });
  });

  it('a 2xx with the wrong shape is an unexpected response', async () => {
    backend({
      'POST /store/vault/:id/buyback': { body: { amount: 'lots' } },
    });
    expect(await sellBackPull('pull_1')).toEqual({
      ok: false,
      error: 'Got an unexpected response. Please try again.',
    });
  });
});
