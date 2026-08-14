import { describe, it, expect } from 'vitest';
import { mapVaultItem, type BackendVaultItem } from '../vault-map';

const row = (over: Partial<BackendVaultItem> = {}): BackendVaultItem => ({
  pull_id: 'pull_1',
  rolled_at: '2026-08-14T00:00:00.000Z',
  pack_id: 'bronze-pack',
  pack_title: 'Bronze Pack',
  card: {
    handle: 'h',
    name: 'Card',
    image: '/c.webp',
    rarity: 'Common',
    market_value: 10,
    marketPriceMyr: 40,
  },
  buyback: { percent: 90, amount: 36, firm: true },
  ...over,
});

describe('mapVaultItem — source/locked', () => {
  it('carries the backend flags through', () => {
    const out = mapVaultItem(
      row({
        source: 'free',
        locked: true,
        buyback: { percent: 90, amount: 0, firm: true },
      }),
    );
    expect(out.source).toBe('free');
    expect(out.locked).toBe(true);
    // A locked quote is UNQUOTED_BUYBACK with the REAL fx firmness — the lock
    // must be carried by `locked`, never by a fake `firm: false` (which the
    // vault aggregates globally and would blame on a pricing outage).
    expect(out.buyback.firm).toBe(true);
    expect(out.buyback.amount).toBe(0);
  });

  it('defaults an older payload to source "pack" / locked false', () => {
    const out = mapVaultItem(row());
    expect(out.source).toBe('pack');
    expect(out.locked).toBe(false);
  });

  it("leaves a challenge prize (source 'reward') unlocked and sellable", () => {
    const out = mapVaultItem(row({ source: 'reward', locked: false }));
    expect(out.locked).toBe(false);
    expect(out.buyback.amount).toBe(36);
  });
});
