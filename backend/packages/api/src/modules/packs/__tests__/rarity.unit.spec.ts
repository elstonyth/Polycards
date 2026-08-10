import { RARITY_ORDER, bestRarity, rarityRank } from '../rarity';
import { challengePackId, isChallengePrizePack } from '../challenge-prize';

describe('bestRarity', () => {
  it('picks the apex tier regardless of input order', () => {
    expect(bestRarity(['Common', 'Immortal', 'Rare'])).toBe('Immortal');
    expect(bestRarity(['Immortal', 'Common'])).toBe('Immortal');
  });

  it('returns null when there is nothing to rank', () => {
    expect(bestRarity([])).toBeNull();
    expect(bestRarity([null, undefined])).toBeNull();
  });

  // A row written by an older enum must not blank the frame for the rows that
  // ARE valid — the unknown value is skipped, not treated as apex or as fatal.
  it('ignores unknown tiers instead of ranking them', () => {
    expect(bestRarity(['Epic', 'Rare'])).toBe('Rare');
    expect(bestRarity(['Epic'])).toBeNull();
  });

  it('ranks the documented order, apex first', () => {
    const ranks = RARITY_ORDER.map(rarityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(rarityRank('Immortal')).toBeLessThan(rarityRank('Common'));
    // Unknown sorts last so it can never outrank a real tier.
    expect(rarityRank('Nonsense')).toBe(RARITY_ORDER.length);
  });
});

describe('isChallengePrizePack', () => {
  it('matches exactly what challengePackId mints', () => {
    expect(isChallengePrizePack(challengePackId('2026-07-19T00:00:00Z'))).toBe(
      true,
    );
  });

  // The frame decision rides on this: a real pack slug that merely starts with
  // "challenge-" must not put the prize frame on an ordinary pull.
  it('rejects an admin-authored slug that only shares the prefix', () => {
    expect(isChallengePrizePack('challenge-cup-2026')).toBe(false);
    expect(isChallengePrizePack('challenge-')).toBe(false);
    expect(isChallengePrizePack('bronze-pack')).toBe(false);
  });

  it('is null-safe', () => {
    expect(isChallengePrizePack(null)).toBe(false);
    expect(isChallengePrizePack(undefined)).toBe(false);
  });
});
