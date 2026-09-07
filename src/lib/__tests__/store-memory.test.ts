/**
 * The in-memory `Store` (src/lib/store-memory.ts) that action and loader tests
 * seed instead of mocking the SDK. It runs the real port pipeline, so what is
 * pinned here is only what the double adds: route matching, request
 * recording, and the token it sends.
 */
import { describe, it, expect } from 'vitest';
import { memoryStore } from '@/lib/store-memory';
import { BalanceSchema } from '@/lib/data/schemas';

describe('memoryStore — routes', () => {
  it('answers a registered "METHOD /path" with its body, status 200 by default', async () => {
    const mem = memoryStore({
      'GET /store/credits/balance': { body: { balance: 7 } },
    });
    expect(await mem.get('/store/credits/balance', BalanceSchema)).toEqual({
      ok: true,
      data: { balance: 7 },
    });
  });

  it('a `:param` segment matches any one segment; a function handler sees the request', async () => {
    const mem = memoryStore({
      'POST /store/vault/:id/buyback': (req) => ({
        body: { balance: (req.body as { n: number }).n },
      }),
    });
    expect(
      await mem.post('/store/vault/pull_1/buyback', BalanceSchema, { n: 3 }),
    ).toEqual({ ok: true, data: { balance: 3 } });
    await expect(
      mem.post('/store/vault/pull_1/buyback/extra', BalanceSchema, {}),
    ).rejects.toThrow(/no route/);
  });

  it('an unregistered route is a test bug and says so loudly', async () => {
    await expect(
      memoryStore({}).get('/store/nope', BalanceSchema),
    ).rejects.toThrow('memoryStore: no route for GET /store/nope');
  });

  it('a non-2xx classifies like the HTTP adapter; text from the body message, else the status', async () => {
    const mem = memoryStore({
      'GET /a': { status: 404, body: { message: 'gone' } },
      'GET /b': { status: 429 },
      'GET /c': { status: 401, body: { message: 'Invalid token.' } },
    });
    expect(await mem.get('/a', BalanceSchema)).toEqual({
      ok: false,
      kind: 'not_found',
      status: 404,
      text: 'gone',
    });
    expect(await mem.get('/b', BalanceSchema)).toEqual({
      ok: false,
      kind: 'rate_limited',
      status: 429,
      text: 'HTTP 429',
    });
    expect(await mem.get('/c', BalanceSchema)).toEqual({
      ok: false,
      kind: 'unauthenticated',
      status: 401,
      text: 'Invalid token.',
    });
  });

  it('a 2xx body that fails the schema is invalid_shape', async () => {
    const mem = memoryStore({ 'GET /a': { body: { balance: 'lots' } } });
    expect(await mem.get('/a', BalanceSchema)).toMatchObject({
      ok: false,
      kind: 'invalid_shape',
    });
  });
});

describe('memoryStore — requests', () => {
  it('records method, path, headers and body of every call that reached the backend', async () => {
    const mem = memoryStore({
      'POST /store/credits/topup': { body: { balance: 1 } },
    });
    await mem.post(
      '/store/credits/topup',
      BalanceSchema,
      { amount: 50 },
      { idempotencyKey: 'k1' },
    );
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/credits/topup',
        headers: {
          Authorization: 'Bearer test-token',
          'Idempotency-Key': 'k1',
        },
        cache: 'no-store',
        body: { amount: 50 },
      },
    ]);
  });
});

describe('memoryStore — token', () => {
  it('is a logged-in customer by default; `token: null` is logged out and never reaches the backend', async () => {
    const out = memoryStore(
      { 'GET /x': { body: { balance: 1 } } },
      { token: null },
    );
    expect(await out.get('/x', BalanceSchema)).toEqual({
      ok: false,
      kind: 'unauthenticated',
      text: 'Not authenticated.',
    });
    expect(out.requests).toEqual([]);
  });

  it('a custom token rides in the bearer; auth none / optional drop it as the HTTP adapter does', async () => {
    const mem = memoryStore(
      { 'GET /x': { body: { balance: 1 } } },
      { token: 'abc' },
    );
    await mem.get('/x', BalanceSchema);
    await mem.get('/x', BalanceSchema, { auth: 'none' });
    expect(mem.requests.map((r) => r.headers)).toEqual([
      { Authorization: 'Bearer abc' },
      {},
    ]);

    const out = memoryStore(
      { 'GET /x': { body: { balance: 1 } } },
      { token: null },
    );
    expect(await out.get('/x', BalanceSchema, { auth: 'optional' })).toEqual({
      ok: true,
      data: { balance: 1 },
    });
    expect(out.requests[0]?.headers).toEqual({});
  });
});
