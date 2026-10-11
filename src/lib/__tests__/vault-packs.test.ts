import { describe, it, expect } from 'vitest';
import {
  giftsHeldFor,
  giftsUsed,
  spinBetLabel,
  vaultButtonLabel,
  vaultCostLabel,
  type PackGift,
} from '../vault-packs';

// Spec 2026-10-07 §1 — the labels are quoted from it verbatim.

describe('giftsUsed — gifts cover rows first, never more than held', () => {
  it('takes the smaller of rows and gifts held', () => {
    expect(giftsUsed(1, 2)).toBe(1);
    expect(giftsUsed(2, 1)).toBe(1);
    expect(giftsUsed(2, 2)).toBe(2);
    expect(giftsUsed(3, 0)).toBe(0);
  });

  it('never goes negative', () => {
    expect(giftsUsed(2, -1)).toBe(0);
  });
});

describe('giftsHeldFor — the usable gifts for one pack', () => {
  const gift = (over: Partial<PackGift> = {}): PackGift => ({
    packId: 'bronze',
    count: 2,
    title: 'Bronze Pack',
    image: null,
    price: 300,
    available: true,
    ...over,
  });

  it('counts only this pack, and only while it can be opened', () => {
    expect(
      giftsHeldFor(
        [
          gift(),
          gift({ packId: 'silver', count: 5 }),
          gift({ count: 1, available: false }),
        ],
        'bronze',
      ),
    ).toBe(2);
    expect(giftsHeldFor([], 'bronze')).toBe(0);
    expect(giftsHeldFor(null, 'bronze')).toBe(0);
  });
});

describe('vaultCostLabel — the pack page price line', () => {
  it('names the gifts alone when every row is a gift', () => {
    expect(vaultCostLabel(1, 1, 300)).toBe('Vault x1');
    expect(vaultCostLabel(2, 2, 300)).toBe('Vault x2');
  });

  it('adds the paid rows when some are not', () => {
    expect(vaultCostLabel(2, 1, 300)).toBe('Vault x1 + RM 300.00');
    expect(vaultCostLabel(3, 1, 1.1)).toBe('Vault x1 + RM 2.20');
  });

  it('is null without gifts, so the usual price line stays', () => {
    expect(vaultCostLabel(2, 0, 300)).toBeNull();
  });
});

describe('spinBetLabel — the spin page bet line', () => {
  it('matches the existing "Bet RM300.00" formatting', () => {
    expect(spinBetLabel(1, 1, 300)).toBe('Bet Vault x1');
    expect(spinBetLabel(2, 1, 300)).toBe('Bet Vault x1 + RM300.00');
    expect(spinBetLabel(2, 2, 300)).toBe('Bet Vault x2');
    expect(spinBetLabel(3, 1, 1500)).toBe('Bet Vault x1 + RM3,000.00');
  });

  it('is null without gifts', () => {
    expect(spinBetLabel(1, 0, 300)).toBeNull();
  });
});

describe('vaultButtonLabel — the pack page button', () => {
  it('reads "Open Vault xG" only when every row is a gift', () => {
    expect(vaultButtonLabel(1, 1)).toBe('Open Vault x1');
    expect(vaultButtonLabel(2, 2)).toBe('Open Vault x2');
  });

  it('is null otherwise, so the usual "Open Pack" stays', () => {
    expect(vaultButtonLabel(2, 1)).toBeNull();
    expect(vaultButtonLabel(1, 0)).toBeNull();
  });
});
