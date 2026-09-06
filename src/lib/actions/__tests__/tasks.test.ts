import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The actions import the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). Nothing
// beneath the port (SDK, cookies, logger) is mocked — the real schema parsing
// runs.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import { checkInToday, claimTaskReward, spinTaskReward } from '../tasks';

const CARD = {
  handle: 'pikachu-base-58',
  name: 'Pikachu',
  rarity: 'Rare',
  market_value: 12,
  marketPriceMyr: 60,
  image: 'https://cdn/pikachu.png',
  slab_image: 'https://cdn/pikachu-slab.png',
};

describe('checkInToday', () => {
  it('posts to the check-in route with no body at all', async () => {
    const mem = backend({
      'POST /store/tasks/checkin': { body: { checked: true } },
    });
    expect(await checkInToday()).toEqual({ ok: true, checked: true });
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/tasks/checkin',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await checkInToday()).toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mem.requests).toEqual([]);
  });

  it('a backend refusal keeps the action’s own sentence', async () => {
    backend({ 'POST /store/tasks/checkin': { status: 500 } });
    expect(await checkInToday()).toEqual({
      ok: false,
      error: 'Could not check in. Please try again.',
    });
  });
});

describe('claimTaskReward', () => {
  it('claims a pack reward and hands back the spin entitlement', async () => {
    const mem = backend({
      'POST /store/tasks/:id/claim': {
        body: {
          claimed: true,
          claimId: 'clm_1',
          reward: { type: 'pack', pack_id: 'bronze' },
        },
      },
    });
    expect(await claimTaskReward('task_1')).toEqual({
      ok: true,
      claimed: true,
      rewardType: 'pack',
      spin: { claimId: 'clm_1', packId: 'bronze' },
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/tasks/task_1/claim',
    });
  });

  it('passes a refusal reason straight through', async () => {
    backend({
      'POST /store/tasks/:id/claim': {
        body: { claimed: false, reason: 'window_closed' },
      },
    });
    expect(await claimTaskReward('task_1')).toEqual({
      ok: true,
      claimed: false,
      reason: 'window_closed',
    });
  });
});

describe('spinTaskReward', () => {
  it('spends the entitlement and maps the pull for the reveal', async () => {
    const mem = backend({
      'POST /store/tasks/claims/:id/spin': {
        body: {
          redeemed: true,
          pullId: 'pull_1',
          card: CARD,
          locked: false,
          buyback: { percent: 60, amount: 36 },
        },
      },
    });
    const r = await spinTaskReward('clm_1');
    expect(r).toMatchObject({
      ok: true,
      redeemed: true,
      pullId: 'pull_1',
      marketValue: 12,
      locked: false,
      buyback: { percent: 60, amount: 36, firm: true },
      card: {
        id: 'pikachu-base-58',
        name: 'Pikachu',
        image: 'https://cdn/pikachu.png',
        slab_image: 'https://cdn/pikachu-slab.png',
        value: 'RM 60.00',
      },
    });
    // The one wire assertion for a spend: the claim id is in the path, and
    // nothing else rides along.
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/tasks/claims/clm_1/spin',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  it('rejects an empty claim id before any request', async () => {
    const mem = backend({});
    expect(await spinTaskReward('  ')).toEqual({
      ok: false,
      error: 'Invalid free rip.',
    });
    expect(mem.requests).toEqual([]);
  });

  // `already_redeemed` is a SUCCESS from the player's side — a previous attempt
  // did land — so it must not surface as an error.
  it('reports already_redeemed as a non-error outcome', async () => {
    backend({
      'POST /store/tasks/claims/:id/spin': {
        body: { redeemed: false, reason: 'already_redeemed' },
      },
    });
    expect(await spinTaskReward('clm_1')).toEqual({
      ok: true,
      redeemed: false,
      reason: 'already_redeemed',
    });
  });

  // The entitlement is SPENT by the time this body arrives, so an unreadable
  // card must not read as "try again" — and the envelope is deliberately not
  // schema-checked, so the port cannot turn one into a generic failure either.
  it('an unreadable card is its own answer, never the retry copy', async () => {
    backend({
      'POST /store/tasks/claims/:id/spin': {
        body: { redeemed: true, pullId: 'pull_1', card: { name: 'Pikachu' } },
      },
    });
    expect(await spinTaskReward('clm_1')).toEqual({
      ok: false,
      error: 'Got an unexpected response. Try again.',
    });
  });

  it('an older backend without `locked` defaults to locked, never a sell that 400s', async () => {
    backend({
      'POST /store/tasks/claims/:id/spin': {
        body: { redeemed: true, pullId: 'pull_1', card: CARD },
      },
    });
    const r = await spinTaskReward('clm_1');
    expect(r.ok && r.redeemed && r.locked).toBe(true);
    expect(r.ok && r.redeemed && r.buyback).toBeNull();
  });
});
