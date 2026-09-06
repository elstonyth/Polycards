import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The actions import the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). `logger` keeps
// a mock: openBatch logs the roll it drops, and that line is asserted.
const mocks = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { openPack, openBatch, revealPull, closeInstantWindow } from '../packs';

const CARD = {
  handle: 'pikachu-base-58',
  name: 'Pikachu',
  rarity: 'Rare',
  market_value: 12,
  marketPriceMyr: 60,
  image: 'https://cdn/pikachu.png',
  slab_image: 'https://cdn/pikachu-slab.png',
};

const OPEN_OK = {
  body: {
    pull: { id: 'pull_1' },
    card: CARD,
    balance: 940,
    price: 60,
    buyback: { percent: 60, amount: 36 },
    free: false,
    locked: false,
  },
};

describe('openPack', () => {
  // The one wire assertion for a CHARGED action: the slug is in the path, the
  // body is empty, and the bearer is the customer's — the backend derives the
  // account from that token alone, so no id may ride along.
  it('posts an empty body to the slug route and maps the pull', async () => {
    const mem = backend({ 'POST /store/packs/:slug/open': OPEN_OK });
    expect(await openPack('bronze')).toEqual({
      ok: true,
      card: {
        id: 'pikachu-base-58',
        name: 'Pikachu',
        image: 'https://cdn/pikachu.png',
        slab_image: 'https://cdn/pikachu-slab.png',
        value: 'RM 60.00',
        rarity: 'Rare',
        pokemon_dex: null,
        sprite_image: null,
        marketPriceMyr: 60,
      },
      pullId: 'pull_1',
      marketValue: 12,
      buyback: {
        percent: 60,
        amount: 36,
        vaultPercent: null,
        vaultAmount: null,
        instantDeadlineMs: null,
        firm: true,
      },
      balance: 940,
      price: 60,
      free: false,
      locked: false,
    });
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/packs/bronze/open',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
        body: {},
      },
    ]);
  });

  it('encodes the slug into the path', async () => {
    const mem = backend({ 'POST /store/packs/:slug/open': OPEN_OK });
    await openPack('a b/c');
    expect(mem.requests[0]?.path).toBe('/store/packs/a%20b%2Fc/open');
  });

  it.each([
    ['an empty slug', ''],
    ['a whitespace slug', '   '],
  ])('refuses %s before any request', async (_label, slug) => {
    const mem = backend({});
    expect(await openPack(slug)).toEqual({ ok: false, error: 'Invalid pack.' });
    expect(mem.requests).toEqual([]);
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await openPack('bronze')).toEqual({
      ok: false,
      error: 'Please log in to open a pack.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  it('flags an insufficient balance so the caller can open the top-up sheet', async () => {
    backend({
      'POST /store/packs/:slug/open': {
        status: 400,
        body: { message: 'Not enough credits.' },
      },
    });
    expect(await openPack('bronze')).toEqual({
      ok: false,
      error: 'Not enough credits to open this pack.',
      needsAuth: false,
      needsTopUp: true,
    });
  });

  it('maps an empty prize pool ahead of the generic not-found copy', async () => {
    backend({
      'POST /store/packs/:slug/open': {
        status: 404,
        body: { message: 'Pack has no odds configured.' },
      },
    });
    expect(await openPack('bronze')).toMatchObject({
      ok: false,
      error: "This pack isn't ready yet — check back soon.",
    });
  });

  // The charge is committed by the time this body arrives. The envelope is
  // deliberately NOT schema-checked, so a card the mapper cannot read gets the
  // "it's in your Vault" sentence — never PACKS_FALLBACK's "try again", which
  // over a charged open is an invitation to pay twice.
  it('an unreadable card never says "try again" over a charged open', async () => {
    backend({
      'POST /store/packs/:slug/open': {
        body: { pull: { id: 'pull_1' }, card: { name: 'Pikachu' } },
      },
    });
    expect(await openPack('bronze')).toEqual({
      ok: false,
      error:
        "Your pack opened and the card is in your Vault, but we couldn't show it here.",
    });
  });

  it('a backend that predates `locked` falls back to `free`, never offering a sell that 400s', async () => {
    backend({
      'POST /store/packs/:slug/open': {
        body: { pull: { id: 'p' }, card: CARD, free: true },
      },
    });
    const r = await openPack('bronze');
    expect(r.ok && r.locked).toBe(true);
    expect(r.ok && r.balance).toBeNull();
    expect(r.ok && r.price).toBeNull();
  });
});

describe('openBatch', () => {
  const roll = (id: string) => ({
    pull: { id },
    card: CARD,
    buyback: { percent: 60, amount: 36 },
  });

  it('posts the clamped count and totals the batch', async () => {
    const mem = backend({
      'POST /store/packs/:slug/open-batch': {
        body: {
          rolls: [roll('pull_1'), roll('pull_2')],
          balance: 880,
          price: 60,
          total_charged: 120,
        },
      },
    });
    const r = await openBatch('bronze', 2);
    expect(r).toMatchObject({ ok: true, balance: 880, price: 60, total: 120 });
    expect(r.ok && r.rolls.map((x) => x.pullId)).toEqual(['pull_1', 'pull_2']);
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/packs/bronze/open-batch',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
        body: { count: 2 },
      },
    ]);
  });

  // The count decides the CHARGE, so the clamp has to reach the wire — a
  // hand-rolled POST asking for 99 must be billed for 3.
  it.each([
    [99, 3],
    [0, 1],
    [-5, 1],
    [2.7, 2],
  ])('clamps a requested %p to %p on the wire', async (asked, sent) => {
    const mem = backend({
      'POST /store/packs/:slug/open-batch': { body: { rolls: [] } },
    });
    await openBatch('bronze', asked);
    expect(mem.requests[0]?.body).toEqual({ count: sent });
  });

  it('drops a roll it cannot map and keeps the rest', async () => {
    backend({
      'POST /store/packs/:slug/open-batch': {
        body: { rolls: [roll('pull_1'), { card: { name: 'Pikachu' } }] },
      },
    });
    const r = await openBatch('bronze', 2);
    expect(r.ok && r.rolls.map((x) => x.pullId)).toEqual(['pull_1']);
    expect(mocks.logError).toHaveBeenCalledWith(
      "[packs] open-batch roll failed to map for 'bronze'",
    );
  });

  it('refuses only when NOTHING mapped, and says where the cards went', async () => {
    backend({
      'POST /store/packs/:slug/open-batch': {
        body: { rolls: [{ card: { name: 'Pikachu' } }] },
      },
    });
    expect(await openBatch('bronze', 1)).toEqual({
      ok: false,
      error:
        "Your pack opened and the card is in your Vault, but we couldn't show it here.",
    });
  });

  // The envelope is unchecked on purpose, so nothing upstream catches a body
  // without `rolls` — iterating it would throw inside a 'use server' action.
  // Pre-port that was a TypeError caught by the action's own try/catch,
  // answered with the generic PACKS_FALLBACK copy (needsAuth/needsTopUp both
  // false) — the guard exists to keep that exact answer without throwing.
  it('a body with no rolls array answers, never throws, over a charged batch', async () => {
    backend({
      'POST /store/packs/:slug/open-batch': { body: { balance: 880 } },
    });
    expect(await openBatch('bronze', 2)).toEqual({
      ok: false,
      error: 'Could not open the pack. Please try again.',
      needsAuth: false,
      needsTopUp: false,
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      "[packs] open-batch returned no rolls array for 'bronze'",
    );
  });

  // An explicit empty array is a legal (if odd) 2xx and has always answered ok.
  it('leaves an explicitly empty rolls array alone', async () => {
    backend({ 'POST /store/packs/:slug/open-batch': { body: { rolls: [] } } });
    expect(await openBatch('bronze', 1)).toMatchObject({ ok: true, rolls: [] });
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await openBatch('bronze', 3)).toEqual({
      ok: false,
      error: 'Please log in to open a pack.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  it('flags an insufficient balance', async () => {
    backend({
      'POST /store/packs/:slug/open-batch': {
        status: 400,
        body: { message: 'Not enough credits.' },
      },
    });
    expect(await openBatch('bronze', 3)).toEqual({
      ok: false,
      error: 'Not enough credits to open this pack.',
      needsAuth: false,
      needsTopUp: true,
    });
  });
});

describe('revealPull / closeInstantWindow', () => {
  it('stamps the reveal and reads the deadline back', async () => {
    const mem = backend({
      'POST /store/pulls/:id/reveal': {
        body: { instant_deadline_ms: 1_700_000_000_000 },
      },
    });
    expect(await revealPull('pull_1')).toEqual({
      ok: true,
      instantDeadlineMs: 1_700_000_000_000,
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/pulls/pull_1/reveal',
      body: {},
    });
  });

  // Best-effort: the overlay falls back to the open response's deadline.
  it.each([
    ['a failed ping', { 'POST /store/pulls/:id/reveal': { status: 500 } }],
    [
      'a body without the deadline',
      { 'POST /store/pulls/:id/reveal': { body: {} } },
    ],
  ])('answers { ok: false } on %s', async (_label, routes) => {
    backend(routes);
    expect(await revealPull('pull_1')).toEqual({ ok: false });
  });

  it('closes the window for the whole selection, dropping blank ids', async () => {
    const mem = backend({ 'POST /store/pulls/close-instant': { body: {} } });
    await closeInstantWindow(['pull_1', '', '  ', 'pull_2']);
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/pulls/close-instant',
      body: { pull_ids: ['pull_1', 'pull_2'] },
    });
  });

  it('sends nothing when every id was blank', async () => {
    const mem = backend({});
    await closeInstantWindow(['', '  ']);
    expect(mem.requests).toEqual([]);
  });
});
