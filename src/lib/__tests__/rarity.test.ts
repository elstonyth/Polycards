import { describe, it, expect } from 'vitest';
import { rarityWinVolume, RARITY_ORDER } from '@/lib/rarity';

describe('rarityWinVolume', () => {
  it('is 1.0 for the top tier and strictly decreasing down the order', () => {
    expect(rarityWinVolume('Immortal')).toBe(1);
    const vols = RARITY_ORDER.map((r) => rarityWinVolume(r));
    for (let i = 1; i < vols.length; i++) {
      expect(vols[i]).toBeLessThan(vols[i - 1] ?? Number.NaN);
    }
  });
  it('reads unknown rarities as Common (quietest)', () => {
    expect(rarityWinVolume('???')).toBe(rarityWinVolume('Common'));
  });
  it('stays within HTMLMediaElement volume bounds', () => {
    for (const r of RARITY_ORDER) {
      const v = rarityWinVolume(r);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
