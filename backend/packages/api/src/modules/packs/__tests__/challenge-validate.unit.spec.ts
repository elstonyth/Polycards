import {
  validateChallengeStages,
  validateChallengeSettingsPatch,
} from '../challenge-validate';

const stage = (over: Partial<Record<string, unknown>> = {}) => ({
  stage_number: 1,
  threshold_myr: 100,
  rank_rewards: [{ rank: 1, card_id: null, credits: 10 }],
  ...over,
});

describe('validateChallengeStages', () => {
  it('accepts an empty stage list (challenge disabled)', () => {
    expect(validateChallengeStages({ stages: [] })).toEqual([]);
  });

  it('accepts contiguous stages with increasing thresholds', () => {
    const out = validateChallengeStages({
      stages: [
        stage(),
        stage({
          stage_number: 2,
          threshold_myr: 200,
          rank_rewards: [{ rank: 1, card_id: 'card_1', credits: 0 }],
        }),
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[1].rank_rewards).toEqual([
      { rank: 1, card_id: 'card_1', credits: 0 },
    ]);
  });

  it('accepts a sparse table, a card AND credits on one rank, and sorts by rank', () => {
    const out = validateChallengeStages({
      stages: [
        stage({
          rank_rewards: [
            { rank: 10, credits: 5 },
            { rank: 1, card_id: 'card_1', credits: 250 },
          ],
        }),
      ],
    });
    expect(out[0].rank_rewards).toEqual([
      { rank: 1, card_id: 'card_1', credits: 250 },
      { rank: 10, card_id: null, credits: 5 },
    ]);
  });

  it('rejects a stage-number gap', () => {
    expect(() =>
      validateChallengeStages({ stages: [stage(), stage({ stage_number: 3, threshold_myr: 200 })] }),
    ).toThrow(/must be 2 \(contiguous/);
  });

  it('rejects non-increasing thresholds', () => {
    expect(() =>
      validateChallengeStages({ stages: [stage(), stage({ stage_number: 2, threshold_myr: 100 })] }),
    ).toThrow(/must exceed stage 1's/);
  });

  it('rejects an out-of-range or non-integer rank', () => {
    for (const rank of [0, 11, 1.5, '1']) {
      expect(() =>
        validateChallengeStages({ stages: [stage({ rank_rewards: [{ rank }] })] }),
      ).toThrow(/rank must be an integer 1/);
    }
  });

  it('rejects a duplicate rank', () => {
    expect(() =>
      validateChallengeStages({
        stages: [stage({ rank_rewards: [{ rank: 2, credits: 1 }, { rank: 2, credits: 2 }] })],
      }),
    ).toThrow(/duplicate rank 2/);
  });

  it('rejects negative credits', () => {
    expect(() =>
      validateChallengeStages({ stages: [stage({ rank_rewards: [{ rank: 1, credits: -1 }] })] }),
    ).toThrow(/credits must be >= 0/);
  });

  it('rejects a malformed rank_rewards table or card_id', () => {
    expect(() => validateChallengeStages({ stages: [stage({ rank_rewards: 'x' })] })).toThrow(
      /must be an array of rank rewards/,
    );
    expect(() => validateChallengeStages({ stages: [stage({ rank_rewards: [1] })] })).toThrow(
      /each entry must be an object/,
    );
    expect(() =>
      validateChallengeStages({ stages: [stage({ rank_rewards: [{ rank: 1, card_id: '  ' }] })] }),
    ).toThrow(/card_id must be a non-empty card id or null/);
  });
});

describe('validateChallengeSettingsPatch', () => {
  it('accepts a partial patch of valid fields', () => {
    const out = validateChallengeSettingsPatch({
      patch: { timezone: 'Asia/Kuala_Lumpur', reset_day: 1, reset_hour: 0, payout_credits: 50 },
    });
    expect(out).toEqual({
      timezone: 'Asia/Kuala_Lumpur',
      reset_day: 1,
      reset_hour: 0,
      payout_credits: 50,
    });
  });

  it('rejects an invalid cadence', () => {
    expect(() => validateChallengeSettingsPatch({ patch: { cadence: 'rolling' } })).toThrow(
      /cadence must be 'fixed_weekly'/,
    );
  });

  it('rejects a bad timezone', () => {
    expect(() => validateChallengeSettingsPatch({ patch: { timezone: 'Mars/Olympus' } })).toThrow(
      /valid IANA time zone/,
    );
  });

  it('rejects out-of-range reset_day / reset_hour', () => {
    expect(() => validateChallengeSettingsPatch({ patch: { reset_day: 7 } })).toThrow(
      /reset_day must be an integer 0.6/,
    );
    expect(() => validateChallengeSettingsPatch({ patch: { reset_hour: 24 } })).toThrow(
      /reset_hour must be an integer 0.23/,
    );
  });

  it('rejects negative payout_credits and an empty patch', () => {
    expect(() => validateChallengeSettingsPatch({ patch: { payout_credits: -1 } })).toThrow(
      /payout_credits must be >= 0/,
    );
    expect(() => validateChallengeSettingsPatch({ patch: {} })).toThrow(
      /No valid settings/,
    );
  });
});
