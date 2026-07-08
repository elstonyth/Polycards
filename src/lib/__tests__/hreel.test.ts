import { describe, expect, test } from 'vitest';
import {
  HREEL_STRIP_LEN,
  HREEL_WIN_INDEX,
  decoyRarity,
  teaseRarity,
  buildHReelStrip,
} from '@/lib/hreel';

describe('decoyRarity', () => {
  test('cycles the full 6-tier palette (varied flicker)', () => {
    const seen = new Set(Array.from({ length: 12 }, (_, i) => decoyRarity(i)));
    expect(seen.size).toBe(6);
  });
});

describe('teaseRarity (spec §7b gating)', () => {
  test('a Common win gets NO faked near-miss', () => {
    expect(teaseRarity('Common')).toBeNull();
  });
  test('a mid win teases ONE tier up', () => {
    expect(teaseRarity('Uncommon')).toBe('Rare');
    expect(teaseRarity('Rare')).toBe('Mythical');
  });
  test('a top win teases its own tier (the prize approaches, then lands)', () => {
    expect(teaseRarity('Mythical')).toBe('Mythical');
    expect(teaseRarity('Legendary')).toBe('Legendary');
    expect(teaseRarity('Immortal')).toBe('Immortal');
  });
});

describe('buildHReelStrip', () => {
  test('pins the winner dex at the win index', () => {
    const s = buildHReelStrip(150, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX);
    expect(s).toHaveLength(HREEL_STRIP_LEN);
    expect(s[HREEL_WIN_INDEX]!.dex).toBe(150);
  });
  test('the winner cell carries a DECOY color, never the real tier (spoiler guard)', () => {
    const s = buildHReelStrip(
      150,
      'Immortal',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
    );
    expect(s[HREEL_WIN_INDEX]!.rarity).toBe(decoyRarity(HREEL_WIN_INDEX));
    expect(s[HREEL_WIN_INDEX]!.rarity).not.toBe('Immortal'); // decoyRarity(36) !== Immortal
  });
  test('places the gated near-miss tease at winIndex-1', () => {
    const rare = buildHReelStrip(9, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX);
    expect(rare[HREEL_WIN_INDEX - 1]!.rarity).toBe('Mythical'); // one tier up
    const common = buildHReelStrip(
      9,
      'Common',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
    );
    expect(common[HREEL_WIN_INDEX - 1]!.rarity).toBe(
      decoyRarity(HREEL_WIN_INDEX - 1),
    ); // no faked near-miss
  });
  test('null / out-of-range winner dex falls back to a valid dex', () => {
    for (const bad of [null, 0, 99999]) {
      const s = buildHReelStrip(
        bad,
        'Common',
        HREEL_STRIP_LEN,
        HREEL_WIN_INDEX,
      );
      const w = s[HREEL_WIN_INDEX]!.dex;
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(1025);
    }
  });
  test('rejects invalid geometry', () => {
    expect(() => buildHReelStrip(1, 'Common', 0, 0)).toThrow(RangeError);
    expect(() => buildHReelStrip(1, 'Common', 10, 10)).toThrow(RangeError);
  });
});
