import { standingsHeadline, weekEndsLabel } from '../standings';

const ladder = [
  { stageNumber: 1, thresholdMyr: 300_000 },
  { stageNumber: 2, thresholdMyr: 1_000_000 },
  { stageNumber: 3, thresholdMyr: 2_000_000 },
  { stageNumber: 4, thresholdMyr: 5_000_000 },
];

describe('standingsHeadline', () => {
  it('gives the pool and what the next stage still needs, the amount last', () => {
    expect(standingsHeadline(2_125_220.4, ladder)).toBe(
      'RM 2,125,220 POOLED · STAGE 4 NEEDS RM 2,874,780',
    );
    expect(standingsHeadline(0, ladder)).toBe(
      'RM 0 POOLED · STAGE 1 NEEDS RM 300,000',
    );
  });

  it('counts a stage unlocked at exactly its threshold, as settlement does', () => {
    expect(standingsHeadline(1_000_000, ladder)).toBe(
      'RM 1,000,000 POOLED · STAGE 3 NEEDS RM 1,000,000',
    );
  });

  it('says how many stages are unlocked once the pool has them all', () => {
    expect(standingsHeadline(5_000_000, ladder)).toBe(
      'RM 5,000,000 POOLED · 4 STAGES UNLOCKED',
    );
    expect(standingsHeadline(400_000, [ladder[0]])).toBe(
      'RM 400,000 POOLED · 1 STAGE UNLOCKED',
    );
  });
});

describe('weekEndsLabel', () => {
  it("names the week's last day in its own timezone", () => {
    // Sunday 11 Oct ends at the Monday 00:00 reset in Kuala Lumpur.
    expect(
      weekEndsLabel(new Date('2026-10-11T16:00:00.000Z'), 'Asia/Kuala_Lumpur'),
    ).toBe('SUN 11 OCT');
  });
});
