import { describe, it, expect } from 'vitest';
import { qk } from './query-keys';

describe('qk', () => {
  it('exposes the static list keys', () => {
    expect(qk.packs).toEqual(['admin', 'packs']);
    expect(qk.cards).toEqual(['admin', 'cards']);
    // source + customer segments default to 'all'; the Pack purchases tab keys
    // 'pack', the player tabs key the customer id.
    expect(qk.pulls(0)).toEqual(['admin', 'pulls', 0, 'all', 'all']);
    expect(qk.pulls(2, 'pack')).toEqual(['admin', 'pulls', 2, 'pack', 'all']);
    expect(qk.pulls(0, undefined, 'cus_1')).toEqual([
      'admin',
      'pulls',
      0,
      'all',
      'cus_1',
    ]);
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

  it('keys the pull ledger and the delivery-order list by customer', () => {
    // Both customer segments ALWAYS render (defaulting to 'all'), same reason
    // as qk.customerPulls' status segment: an appended-only segment would make
    // the site-wide key a strict PREFIX of the player-scoped one, so an exact
    // key invalidation of the All Orders table would also nuke a player's tab.
    const global = qk.pulls(0);
    const scoped = qk.pulls(0, undefined, 'cus_1');
    expect(global.length).toBe(scoped.length);
    expect(global).not.toEqual(scoped);
    expect(qk.deliveryOrders(undefined, 0)).toEqual([
      'admin',
      'delivery-orders',
      'all',
      0,
      '',
      'all',
    ]);
    expect(qk.deliveryOrders('shipped', 2, 'abc', 'cus_1')).toEqual([
      'admin',
      'delivery-orders',
      'shipped',
      2,
      'abc',
      'cus_1',
    ]);
    // The 2-segment prefixes still reach every page/filter/customer, so the
    // bulk-update invalidations keep working unchanged.
    for (const key of [global, scoped]) {
      expect(key.slice(0, qk.pullsKey.length)).toEqual([...qk.pullsKey]);
    }
    for (const key of [
      qk.deliveryOrders(undefined, 0),
      qk.deliveryOrders('shipped', 2, 'abc', 'cus_1'),
    ]) {
      expect(key.slice(0, qk.deliveryOrdersKey.length)).toEqual([
        ...qk.deliveryOrdersKey,
      ]);
    }
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
  // Epic 3 (Odds): flat list key for the customer-group -> odds_set page.
  it('exposes the customer-groups key', () => {
    expect(qk.customerGroups).toEqual(['admin', 'customer-groups']);
  });
});
