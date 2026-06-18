import { describe, it, expect } from 'vitest';
import { ballSrc, DECOY_BALLS, BALL_BY_RARITY } from '@/lib/balls';
import type { Rarity } from '@/app/claw/packs-data';

describe('ballSrc', () => {
  it('maps each rarity to its ball asset', () => {
    const cases: [Rarity, string][] = [
      ['Legendary', '/images/balls/master.webp'],
      ['Epic', '/images/balls/luxury.webp'],
      ['Rare', '/images/balls/ultra.webp'],
      ['Uncommon', '/images/balls/great.webp'],
      ['Common', '/images/balls/poke.webp'],
    ];
    for (const [rarity, src] of cases) expect(ballSrc(rarity)).toBe(src);
  });

  it('exposes a non-empty decoy pool of /images/balls paths', () => {
    expect(DECOY_BALLS.length).toBeGreaterThan(0);
    for (const d of DECOY_BALLS) expect(d).toMatch(/^\/images\/balls\/decoy-/);
  });

  it('covers all five rarities', () => {
    expect(Object.keys(BALL_BY_RARITY).sort()).toEqual([
      'Common',
      'Epic',
      'Legendary',
      'Rare',
      'Uncommon',
    ]);
  });
});
