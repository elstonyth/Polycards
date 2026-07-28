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
  });

  // Epic 3 (Odds): flat list key for the customer-group -> odds_set page.
  it('exposes the customer-groups key', () => {
    expect(qk.customerGroups).toEqual(['admin', 'customer-groups']);
  });

  // ── Epic 5 (Inventory) ────────────────────────────────────────────────────

  it('keys the purchase-invoice list under a prefix that invalidates every page', () => {
    // Literal expectations, not just the prefix loop below: renaming the
    // segment in BOTH the builder and the constant would satisfy the loop
    // while silently orphaning every cache entry the pages already hold.
    expect(qk.purchaseInvoicesKey).toEqual(['admin', 'purchase-invoices']);
    expect(qk.purchaseInvoices(0)).toEqual([
      'admin',
      'purchase-invoices',
      0,
      '',
      'created_at:desc',
    ]);
    expect(qk.purchaseInvoices(2, 'acme', 'supplier:asc')).toEqual([
      'admin',
      'purchase-invoices',
      2,
      'acme',
      'supplier:asc',
    ]);
    for (const key of [
      qk.purchaseInvoices(0),
      qk.purchaseInvoices(2, 'acme', 'supplier:asc'),
    ]) {
      expect(key.slice(0, qk.purchaseInvoicesKey.length)).toEqual([
        ...qk.purchaseInvoicesKey,
      ]);
    }
    // Same length + different contents => neither filtered key can be a prefix
    // of the other, so a search/sort change swaps caches instead of nesting.
    expect(qk.purchaseInvoices(0).length).toBe(
      qk.purchaseInvoices(0, 'acme').length,
    );
    expect(qk.purchaseInvoices(0)).not.toEqual(qk.purchaseInvoices(0, 'acme'));
  });

  it('keys one purchase invoice in a SIBLING namespace, not under the list', () => {
    expect(qk.purchaseInvoice('pinv_1')).toEqual([
      'admin',
      'purchase-invoice',
      'pinv_1',
    ]);
    // The list prefix must NOT reach the detail cache: invoices are immutable,
    // so a post-create list invalidation has no business refetching them.
    expect(
      qk.purchaseInvoice('pinv_1').slice(0, qk.purchaseInvoicesKey.length),
    ).not.toEqual([...qk.purchaseInvoicesKey]);
  });

  it('keys the inventory list under a prefix that invalidates every search', () => {
    // Literal expectations on BOTH the builder and the constant. A loop that
    // only checks "the builder starts with the constant" stays green when the
    // segment is renamed in both places at once — which is precisely the
    // change that silently orphans every cache entry the page already holds.
    expect(qk.inventoryKey).toEqual(['admin', 'inventory']);
    expect(qk.inventory()).toEqual(['admin', 'inventory', '']);
    expect(qk.inventory('charizard')).toEqual([
      'admin',
      'inventory',
      'charizard',
    ]);
    for (const key of [qk.inventory(), qk.inventory('charizard')]) {
      expect(key.slice(0, qk.inventoryKey.length)).toEqual([
        ...qk.inventoryKey,
      ]);
    }
    // The `q` segment always renders, so an unfiltered key can never be a
    // strict prefix of a filtered one: same length, different contents.
    expect(qk.inventory().length).toBe(qk.inventory('charizard').length);
    expect(qk.inventory()).not.toEqual(qk.inventory('charizard'));
    // Passing nothing and passing '' are the SAME cache entry — otherwise
    // type-then-clear would double-cache the whole unfiltered catalog.
    expect(qk.inventory()).toEqual(qk.inventory(''));
    // Sibling of the purchase-invoice namespace, not nested under it.
    expect(qk.inventory().slice(0, 2)).not.toEqual([...qk.purchaseInvoicesKey]);
  });

  it('keys one inventory item in a SIBLING namespace, not under the list', () => {
    // Literal expectations on the builder, not just the prefix relation below:
    // renaming the segment leaves every structural assertion in this test green
    // while orphaning the cache entries the page already holds.
    expect(qk.inventoryItem('charizard', 0)).toEqual([
      'admin',
      'inventory-item',
      'charizard',
      0,
    ]);
    expect(qk.inventoryItem('charizard', 2)).toEqual([
      'admin',
      'inventory-item',
      'charizard',
      2,
    ]);
    // THE POINT OF THE SIBLING NAMESPACE: slot 2 of qk.inventory is the
    // operator's SEARCH STRING. Nested under the list key, a detail entry for
    // the card 'charizard' would sit beneath the list entry for the search
    // "charizard" — so a search key would prefix-match an unrelated item cache.
    expect(
      qk.inventoryItem('charizard', 0).slice(0, qk.inventoryKey.length),
    ).not.toEqual([...qk.inventoryKey]);
    expect(qk.inventoryItem('charizard', 0).slice(0, 3)).not.toEqual([
      ...qk.inventory('charizard'),
    ]);
    // The movement page always renders, so no page's key can prefix another's.
    expect(qk.inventoryItem('charizard', 0)).not.toEqual(
      qk.inventoryItem('charizard', 2),
    );
    expect(qk.inventoryItem('charizard', 0).length).toBe(
      qk.inventoryItem('charizard', 2).length,
    );
    // The root useInvalidateInventory actually passes. invalidateQueries matches
    // by PREFIX, so if this constant stops prefixing the builder the call
    // silently matches NOTHING: creating a purchase invoice would leave the item
    // detail showing the stock position from before the purchase, and the fix
    // would still read as correct at the call site.
    //
    // Stated limit, because this file's other structural assertions have the
    // same shape: with the constant AND the builder both pinned to literals, the
    // loop below is logically implied by them and can never be the sole failure
    // under a single mutation — the literal is what catches a one-sided rename,
    // the loop is what catches a both-sides rename. query-core's own
    // partialMatchKey would assert the real runtime semantics instead of
    // restating the literals, but 5.64.2 exposes it only from the internal
    // build/modern/utils chunk, never from the package entry, so importing it is
    // a TS2305 and deep-importing a build chunk is worse than the redundancy.
    expect(qk.inventoryItemKey).toEqual(['admin', 'inventory-item']);
    for (const key of [
      qk.inventoryItem('charizard', 0),
      qk.inventoryItem('charizard', 2),
    ]) {
      expect(key.slice(0, qk.inventoryItemKey.length)).toEqual([
        ...qk.inventoryItemKey,
      ]);
    }
    // ...and it must NOT reach the list namespace, or invalidating the detail
    // would drag the unpaged whole-catalog list along with it.
    expect(
      qk.inventory('charizard').slice(0, qk.inventoryItemKey.length),
    ).not.toEqual([...qk.inventoryItemKey]);
  });
});
