import {
  posterHeadline,
  posterProgress,
  posterWeekLabel,
} from '../challenge-poster';

const ladder = [
  { stageNumber: 1, thresholdMyr: 200_000 },
  { stageNumber: 2, thresholdMyr: 500_000 },
  { stageNumber: 3, thresholdMyr: 1_500_000 },
];

describe('posterHeadline', () => {
  it('names the first threshold while nothing is unlocked', () => {
    expect(posterHeadline(ladder, 150_000)).toEqual({
      headline: 'STAGE 1 UNLOCKS AT RM 200,000',
      featureStage: 1,
    });
  });

  it('names the highest unlocked stage and features it', () => {
    expect(posterHeadline(ladder, 500_000)).toEqual({
      headline: 'STAGE 2 UNLOCKED',
      featureStage: 2,
    });
  });

  it('says all stages are unlocked once the pool clears the last one', () => {
    expect(posterHeadline(ladder, 2_069_034)).toEqual({
      headline: 'ALL 3 STAGES UNLOCKED',
      featureStage: 3,
    });
  });

  it('keeps a one-stage ladder singular', () => {
    expect(posterHeadline([ladder[0]], 250_000)).toEqual({
      headline: 'STAGE 1 UNLOCKED',
      featureStage: 1,
    });
  });
});

describe('posterProgress', () => {
  it('runs the bar to stage 1 while nothing is unlocked', () => {
    expect(posterProgress(ladder, 150_000)).toEqual({
      pooledMyr: 150_000,
      nextStage: 1,
      nextThresholdMyr: 200_000,
    });
  });

  it('runs it on to the next stage once one unlocks', () => {
    expect(posterProgress(ladder, 200_000)).toEqual({
      pooledMyr: 200_000,
      nextStage: 2,
      nextThresholdMyr: 500_000,
    });
  });

  it('has no bar once every stage is unlocked', () => {
    expect(posterProgress(ladder, 1_500_000)).toBeNull();
  });
});

describe('posterWeekLabel', () => {
  it('shows the first and last day in the challenge timezone', () => {
    // Mon 28 Sept 00:00 MYT to Mon 5 Oct 00:00 MYT (end exclusive).
    expect(
      posterWeekLabel(
        new Date('2026-09-27T16:00:00.000Z'),
        new Date('2026-10-04T16:00:00.000Z'),
        'Asia/Kuala_Lumpur',
      ),
    ).toBe('28 SEPT – 4 OCT');
  });
});
