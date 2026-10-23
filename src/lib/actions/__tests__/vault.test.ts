import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The actions import the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). Nothing
// beneath the port (SDK, cookies, logger) is mocked — the real schema parsing
// and copy tables run.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import {
  ackReportedDeposits,
  getPendingDeposits,
  getPullHistory,
  getTransactions,
  getUnreportedDeposits,
  getVault,
  readPendingDeposits,
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

  it('carries what a Singapore bank receives, and nothing for an RM payout', async () => {
    backend({
      'POST /store/credits/withdraw': {
        body: { ...WITHDRAW_OK.body, currency: 'SGD', payAmount: 50.14 },
      },
    });
    expect(
      await startWithdrawal({ amount: 160, accountId: 'acct_1' }),
    ).toMatchObject({ payout: { currency: 'SGD', amount: 50.14 } });
    backend({
      'POST /store/credits/withdraw': {
        body: { ...WITHDRAW_OK.body, currency: 'MYR', payAmount: 50 },
      },
    });
    expect(
      await startWithdrawal({ amount: 50, accountId: 'acct_1' }),
    ).not.toHaveProperty('payout');
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

describe('pending deposits — a failed read is not "nothing pending"', () => {
  it('the deposit watch gets null when the read fails', async () => {
    backend({ 'GET /store/credits/deposit': { status: 429 } });
    expect(await readPendingDeposits()).toBeNull();
  });

  it('the Transactions page still gets its plain empty list', async () => {
    backend({ 'GET /store/credits/deposit': { status: 500 } });
    expect(await getPendingDeposits()).toEqual([]);
  });
});

describe('unreported deposits — the Meta Pixel source and its ack', () => {
  it('maps the settled deposits, keeping the first-ever flag', async () => {
    backend({
      'GET /store/credits/deposit/unreported': {
        body: {
          deposits: [
            { merchant_transaction_id: 'PC-1', amount: 50, first: true },
            { merchant_transaction_id: 'PC-2', amount: 100 },
          ],
        },
      },
    });
    expect(await getUnreportedDeposits()).toEqual([
      { reference: 'PC-1', amount: 50, first: true },
      { reference: 'PC-2', amount: 100, first: false },
    ]);
  });

  it('is null when the read fails, so nothing is treated as reported', async () => {
    backend({ 'GET /store/credits/deposit/unreported': { status: 404 } });
    expect(await getUnreportedDeposits()).toBeNull();
  });

  it('acks the references it was given', async () => {
    const mem = backend({
      'POST /store/credits/deposit/unreported': { body: { acknowledged: 2 } },
    });
    await ackReportedDeposits(['PC-1', 'PC-2']);
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/credits/deposit/unreported',
      body: { references: ['PC-1', 'PC-2'] },
    });
  });

  // A server action is a public endpoint: junk never reaches the backend.
  it.each([
    ['empty', []],
    ['too many', Array.from({ length: 11 }, (_, i) => `PC-${i}`)],
    ['a non-string', ['PC-1', 7 as unknown as string]],
  ])('sends nothing for %s', async (_label, references) => {
    const mem = backend({});
    await ackReportedDeposits(references);
    expect(mem.requests).toEqual([]);
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

describe('getTransactions — the history totals', () => {
  const PAGE = {
    balance: 120,
    topup_total: 200,
    spend_total: 145,
    transactions: [],
    has_more: false,
  };

  it('carries the split totals when the backend sends them', async () => {
    backend({
      'GET /store/credits': {
        body: { ...PAGE, pack_spend_total: 45, withdrawn_total: 100 },
      },
    });
    expect(await getTransactions(1)).toMatchObject({
      ok: true,
      spendTotal: 145,
      packSpendTotal: 45,
      withdrawnTotal: 100,
    });
  });

  // Deploy skew: an older backend sends only spend_total. The page must fall
  // back to its single "Total spent" card, never show a made-up RM 0.00.
  it('reports the split as unknown (null) when an older backend omits it', async () => {
    backend({ 'GET /store/credits': { body: PAGE } });
    expect(await getTransactions(1)).toMatchObject({
      ok: true,
      spendTotal: 145,
      packSpendTotal: null,
      withdrawnTotal: null,
    });
  });

  it('carries the pack and card names; a malformed label never drops the money row', async () => {
    backend({
      'GET /store/credits': {
        body: {
          ...PAGE,
          transactions: [
            {
              id: 't1',
              amount: -45,
              reason: 'pack_open',
              created_at: '2026-10-20T10:00:00.000Z',
              pack_title: 'Bronze Pack',
              card_names: ['Charizard ex', 'Pikachu'],
            },
            {
              id: 't2',
              amount: 72,
              reason: 'buyback',
              created_at: '2026-10-20T10:01:00.000Z',
              pack_title: 7,
              card_names: 'Charizard ex',
            },
          ],
        },
      },
    });
    const r = await getTransactions(1);
    expect(
      r.ok && r.transactions.map((t) => [t.id, t.packTitle, t.cardNames]),
    ).toEqual([
      ['t1', 'Bronze Pack', ['Charizard ex', 'Pikachu']],
      ['t2', null, []],
    ]);
  });
});

describe('getPullHistory', () => {
  const ROW = {
    pull_id: 'p1',
    rolled_at: '2026-10-20T10:00:00.000Z',
    pack_title: 'Bronze Pack',
    source: 'pack',
    status: 'bought_back',
    card: { handle: 'charizard', name: 'Charizard ex', marketPriceMyr: 100 },
    paid: 45,
    value: 80,
    sold_for: 72,
    sold_at: '2026-10-20T10:01:00.000Z',
  };

  it('asks the backend for the page and maps each pull', async () => {
    const mem = backend({
      'GET /store/pulls/history': { body: { items: [ROW], has_more: true } },
    });
    const r = await getPullHistory(2);
    expect(mem.requests[0]).toMatchObject({
      path: '/store/pulls/history',
      query: { limit: 20, offset: 20 },
    });
    expect(r).toMatchObject({
      ok: true,
      page: 2,
      hasMore: true,
      items: [
        {
          pullId: 'p1',
          packTitle: 'Bronze Pack',
          status: 'bought_back',
          paid: 45,
          value: 80,
          soldFor: 72,
          card: { name: 'Charizard ex', priceMyr: 100 },
        },
      ],
    });
  });

  it('a bad figure reads as unknown (never RM 0); a row without a card drops', async () => {
    backend({
      'GET /store/pulls/history': {
        body: {
          items: [{ ...ROW, paid: 'lots' }, { pull_id: 'broken' }],
          has_more: false,
        },
      },
    });
    const r = await getPullHistory(1);
    expect(r.ok && r.items.map((i) => [i.pullId, i.paid])).toEqual([
      ['p1', null],
    ]);
  });
});
