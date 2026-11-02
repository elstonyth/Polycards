import { describe, it, expect } from 'vitest';
import { losslessEligiblePacks, packsLabel } from './lossless';

const titles = new Map([
  ['legend-pack', 'Legend Pack'],
  ['rgb', 'RGB Pack'],
]);

describe('packsLabel', () => {
  it('reads "All packs" for a null scope', () => {
    expect(packsLabel(null, titles)).toBe('All packs');
  });

  it('joins pack titles with commas', () => {
    expect(packsLabel(['legend-pack', 'rgb'], titles)).toBe(
      'Legend Pack, RGB Pack',
    );
  });

  it('shows an unknown slug raw rather than dropping it', () => {
    expect(packsLabel(['legend-pack', 'deleted-pack'], titles)).toBe(
      'Legend Pack, deleted-pack',
    );
  });
});

describe('losslessEligiblePacks', () => {
  it('drops the free welcome pack and reward boxes, keeps paid packs', () => {
    const packs = [
      { slug: 'a', category: 'pokemon' },
      { slug: 'free', category: 'free_welcome' },
      { slug: 'box', category: 'reward_box' },
      { slug: 'b', category: 'one-piece' },
    ];
    expect(losslessEligiblePacks(packs).map((p) => p.slug)).toEqual(['a', 'b']);
  });

  it('drops a ticket pack, which has no buyback to lift', () => {
    const packs = [
      { slug: 'a', category: 'pokemon', prize_type: 'cards' },
      { slug: 'lucky', category: 'poly', prize_type: 'tickets' },
    ];
    expect(losslessEligiblePacks(packs).map((p) => p.slug)).toEqual(['a']);
  });
});
