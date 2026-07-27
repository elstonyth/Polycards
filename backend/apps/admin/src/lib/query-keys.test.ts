import { describe, it, expect } from 'vitest';
import { qk } from './query-keys';

describe('qk', () => {
  it('exposes the static list keys', () => {
    expect(qk.packs).toEqual(['admin', 'packs']);
    expect(qk.cards).toEqual(['admin', 'cards']);
    // source segment defaults to 'all'; the Pack purchases tab keys 'pack'.
    expect(qk.pulls(0)).toEqual(['admin', 'pulls', 0, 'all']);
    expect(qk.pulls(2, 'pack')).toEqual(['admin', 'pulls', 2, 'pack']);
    expect(qk.pullsKey).toEqual(['admin', 'pulls']);
    expect(qk.economy).toEqual(['admin', 'economy']);
    expect(qk.eligibleProducts).toEqual(['admin', 'eligible-products']);
  });

  it('nests odds under the pack key so a pack invalidation can target odds', () => {
    expect(qk.pack('starter')).toEqual(['admin', 'pack', 'starter']);
    expect(qk.packOdds('starter')).toEqual([
      'admin',
      'pack',
      'starter',
      'odds',
    ]);
  });

  it('builds a per-customer gacha key', () => {
    expect(qk.customerGacha('cus_1')).toEqual([
      'admin',
      'customer',
      'cus_1',
      'gacha',
    ]);
  });

  // ── Epic 2 (Players) ──────────────────────────────────────────────────────

  it('keys the players list under a prefix that invalidates every page', () => {
    expect(qk.players(0)).toEqual(['admin', 'players', 0, '']);
    expect(qk.players(2, 'ada')).toEqual(['admin', 'players', 2, 'ada']);
    // playersKey must be a strict prefix of every page key, or a post-disable
    // invalidation would leave the row's status stale on the current page.
    for (const key of [qk.players(0), qk.players(2, 'ada')]) {
      expect(key.slice(0, qk.playersKey.length)).toEqual([...qk.playersKey]);
    }
  });

  it('keys a customer pull page by its status filter', () => {
    // Unfiltered defaults to an explicit 'all' segment (same shape as
    // qk.pulls' source segment) so the Vault tab's vaulted-only cache is a
    // SIBLING of the support page's full history, never a descendant of it.
    expect(qk.customerPulls('cus_1', 0)).toEqual([
      'admin',
      'customer',
      'cus_1',
      'pulls',
      0,
      'all',
    ]);
    expect(qk.customerPulls('cus_1', 2, 'vaulted')).toEqual([
      'admin',
      'customer',
      'cus_1',
      'pulls',
      2,
      'vaulted',
    ]);
    // Neither key is a prefix of the other, and customerPullsKey is still a
    // strict prefix of both (one invalidation still clears every filter/page).
    const key = qk.customerPullsKey('cus_1');
    for (const k of [
      qk.customerPulls('cus_1', 0),
      qk.customerPulls('cus_1', 2, 'vaulted'),
    ]) {
      expect(k.slice(0, key.length)).toEqual([...key]);
    }
    // Same length + different contents ⇒ neither can be a prefix of the other.
    const unfiltered = qk.customerPulls('cus_1', 0);
    const vaulted = qk.customerPulls('cus_1', 0, 'vaulted');
    expect(unfiltered.length).toBe(vaulted.length);
    expect(unfiltered).not.toEqual(vaulted);
  });

  it('nests payout details + spend report under the customer prefix', () => {
    expect(qk.payoutDetails('cus_1')).toEqual([
      'admin',
      'customer',
      'cus_1',
      'payout-details',
    ]);
    expect(qk.spendReport('cus_1')).toEqual([
      'admin',
      'customer',
      'cus_1',
      'spend-report',
    ]);
    // Same 3-segment prefix as the other per-customer keys, so one customer
    // invalidation reaches all of their tabs.
    const prefix = ['admin', 'customer', 'cus_1'];
    for (const key of [
      qk.payoutDetails('cus_1'),
      qk.spendReport('cus_1'),
      qk.customerGacha('cus_1'),
    ]) {
      expect(key.slice(0, 3)).toEqual(prefix);
    }
  });
});
