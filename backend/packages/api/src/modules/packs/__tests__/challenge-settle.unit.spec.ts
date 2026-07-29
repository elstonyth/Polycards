import {
  unlockedStages,
  payoutByRank,
  type SettleStage,
} from '../challenge-settle';

const stage = (
  n: number,
  threshold: number,
  rewards: { rank: number; card_id?: string | null; credits?: number }[],
): SettleStage => ({
  stage_number: n,
  threshold_myr: threshold,
  rank_rewards: rewards.map((r) => ({
    rank: r.rank,
    card_id: r.card_id ?? null,
    credits: r.credits ?? 0,
  })),
});

describe('unlockedStages', () => {
  const stages = [
    stage(1, 1000, [{ rank: 1, credits: 50 }]),
    stage(2, 5000, [{ rank: 1, credits: 100 }]),
    stage(3, 10000, [{ rank: 1, card_id: 'card_a' }]),
  ];

  it('unlocks every stage at or below the pool (>= is inclusive)', () => {
    expect(unlockedStages(stages, 5000).map((s) => s.stage_number)).toEqual([
      1, 2,
    ]);
  });

  it('unlocks nothing below the lowest threshold', () => {
    expect(unlockedStages(stages, 999)).toEqual([]);
  });

  it('unlocks all above the highest threshold', () => {
    expect(unlockedStages(stages, 10_000).map((s) => s.stage_number)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('payoutByRank', () => {
  it('sums credits and collects card ids across unlocked stages', () => {
    const unlocked = [
      stage(1, 0, [
        { rank: 1, credits: 50, card_id: 'card_a' },
        { rank: 4, credits: 20 },
      ]),
      stage(2, 0, [
        { rank: 1, credits: 100, card_id: 'card_b' },
        { rank: 2, card_id: 'card_c' },
      ]),
    ];
    const by = payoutByRank(unlocked);
    expect(by.get(1)).toEqual({
      rank: 1,
      credits: 150,
      cardIds: ['card_a', 'card_b'],
    });
    expect(by.get(2)).toEqual({ rank: 2, credits: 0, cardIds: ['card_c'] });
    expect(by.get(4)).toEqual({ rank: 4, credits: 20, cardIds: [] });
    expect(by.has(3)).toBe(false); // sparse rank pays nothing
  });

  it('keeps duplicate card ids (two stages may award the same card twice)', () => {
    const by = payoutByRank([
      stage(1, 0, [{ rank: 1, card_id: 'card_a' }]),
      stage(2, 0, [{ rank: 1, card_id: 'card_a' }]),
    ]);
    expect(by.get(1)!.cardIds).toEqual(['card_a', 'card_a']);
  });
});
