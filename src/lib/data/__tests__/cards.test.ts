import { beforeEach, describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// getCardResult's job is to distinguish WHY it returned no card: a 404 (unknown
// handle) → the page 404s, but any transient failure (5xx, network,
// schema-invalid) → a retry state, never "Card not found" for a card the
// customer may actually own. The loader reads through the `Store` port, so an
// in-memory backend seeds it (src/lib/__tests__/store-shim.ts) and the real
// CardDetailEnvelopeSchema runs — schema validation is genuine.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import { getCard, getCardResult } from '@/lib/data/cards';
import { clearTtlCache } from '@/lib/ttl-cache';

// Lookups are memoised per handle; start every case cold.
beforeEach(() => clearTtlCache());

const CARD_ROUTE = 'GET /store/cards/:handle';

const validCard = {
  handle: 'db-charizard-1001',
  name: 'Charizard',
  set: 'Base Set',
  grader: 'PSA',
  grade: '10',
  image: '/x.webp',
  slab_image: null,
  marketPriceMyr: 1234.5,
  rarity: 'Legendary',
  pcSyncedAt: null,
  priceHistory: [],
};

describe('getCardResult', () => {
  it('reads the public card route with no bearer and no cache key', async () => {
    // Both halves matter: an Authorization header would make this
    // per-customer, and an explicit cache mode would make a prerenderable
    // caller dynamic. The bare sdk.client.fetch it replaces sent neither.
    const mem = backend({ [CARD_ROUTE]: { body: { card: validCard } } });
    await getCardResult('db-charizard-1001');
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/cards/db-charizard-1001',
      headers: {},
      cache: 'auto',
    });
  });

  it('answers an implausible handle (no digit, odd chars) without a backend call', async () => {
    // 2026-10-25 flood: /card/adasdsad. Every real handle carries a digit id.
    const mem = backend({ [CARD_ROUTE]: { body: { card: validCard } } });
    expect(await getCardResult('adasdsad')).toEqual({ status: 'notfound' });
    expect(await getCardResult('a/b-1')).toEqual({ status: 'notfound' });
    expect(mem.requests).toHaveLength(0);
  });

  it('memoises hits and misses, but never an outage', async () => {
    let mem = backend({ [CARD_ROUTE]: { body: { card: validCard } } });
    await getCardResult('db-charizard-1001');
    await getCardResult('db-charizard-1001');
    expect(mem.requests).toHaveLength(1);

    mem = backend({ [CARD_ROUTE]: { status: 404, body: { message: 'nope' } } });
    await getCardResult('nobody-404');
    await getCardResult('nobody-404');
    expect(mem.requests).toHaveLength(1);

    mem = backend({ [CARD_ROUTE]: { status: 500, body: { message: 'boom' } } });
    expect(await getCardResult('down-500')).toEqual({ status: 'error' });
    mem = backend({ [CARD_ROUTE]: { body: { card: validCard } } });
    expect((await getCardResult('down-500')).status).toBe('ok');
  });

  it('returns { status: "ok", card } for a valid response, as the card view', async () => {
    backend({ [CARD_ROUTE]: { body: { card: validCard } } });
    const res = await getCardResult('db-charizard-1001');
    expect(res).toEqual({
      status: 'ok',
      card: {
        handle: 'db-charizard-1001',
        name: 'Charizard',
        image: '/x.webp',
        slabImage: null,
        rarity: 'Legendary',
        priceMyr: 1234.5,
        pokemonDex: null,
        spriteImage: null,
        set: 'Base Set',
        grader: 'PSA',
        grade: '10',
        pcSyncedAt: null,
        priceHistory: [],
      },
    });
  });

  it('returns { status: "notfound" } on a 404 (genuine miss → page 404s)', async () => {
    backend({ [CARD_ROUTE]: { status: 404, body: { message: 'nope' } } });
    expect(await getCardResult('nobody-404')).toEqual({ status: 'notfound' });
  });

  it('returns { status: "error" } on a 5xx (outage → NOT a 404)', async () => {
    backend({ [CARD_ROUTE]: { status: 500, body: { message: 'boom' } } });
    expect(await getCardResult('db-charizard-1001')).toEqual({
      status: 'error',
    });
  });

  // Pre-port this case was a status-less throw (`new Error('ECONNREFUSED')`).
  // The port classifies on status alone, so a network drop and a bodyless 5xx
  // are the same `kind: 'backend'` here; the status-less variant itself is
  // pinned in store.test.ts ("a failure that never reached a response").
  it('returns { status: "error" } for a failure carrying no message either', async () => {
    backend({ [CARD_ROUTE]: { status: 502 } });
    expect(await getCardResult('db-charizard-1001')).toEqual({
      status: 'error',
    });
  });

  it('returns { status: "error" } on a schema-invalid response', async () => {
    backend({ [CARD_ROUTE]: { body: { card: { handle: 'x', name: 'X' } } } });
    expect(await getCardResult('x-404')).toEqual({ status: 'error' });
  });

  it('returns { status: "error" } on a 200 with no card at all', async () => {
    backend({ [CARD_ROUTE]: { body: {} } });
    expect(await getCardResult('x-404')).toEqual({ status: 'error' });
  });
});

describe('getCard (null-returning view kept for /api/cards)', () => {
  it('returns the card when found', async () => {
    backend({ [CARD_ROUTE]: { body: { card: validCard } } });
    expect(await getCard('db-charizard-1001')).toMatchObject({
      handle: 'db-charizard-1001',
      priceMyr: 1234.5,
      set: 'Base Set',
    });
  });

  it('returns null for both a 404 and an outage', async () => {
    backend({ [CARD_ROUTE]: { status: 404, body: { message: 'nope' } } });
    expect(await getCard('nobody-404')).toBeNull();
    backend({ [CARD_ROUTE]: { status: 500, body: { message: 'boom' } } });
    expect(await getCard('db-charizard-1001')).toBeNull();
  });
});
