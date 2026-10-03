import {
  MAX_AGGREGATE_RANK_CREDITS_MYR,
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
      validateChallengeStages({
        stages: [stage(), stage({ stage_number: 3, threshold_myr: 200 })],
      }),
    ).toThrow(/must be 2 \(contiguous/);
  });

  it('rejects non-increasing thresholds', () => {
    expect(() =>
      validateChallengeStages({
        stages: [stage(), stage({ stage_number: 2, threshold_myr: 100 })],
      }),
    ).toThrow(/must exceed stage 1's/);
  });

  it('accepts a large legal threshold_myr but rejects one above the ceiling', () => {
    expect(
      validateChallengeStages({
        stages: [stage({ threshold_myr: 2_000_000 })],
      }),
    ).toHaveLength(1);
    expect(() =>
      validateChallengeStages({
        stages: [stage({ threshold_myr: 100_000_001 })],
      }),
    ).toThrow(/threshold_myr must be <=/);
  });

  it('rejects an out-of-range or non-integer rank', () => {
    for (const rank of [0, 11, 1.5, '1']) {
      expect(() =>
        validateChallengeStages({
          stages: [stage({ rank_rewards: [{ rank }] })],
        }),
      ).toThrow(/rank must be an integer 1/);
    }
  });

  it('rejects a duplicate rank', () => {
    expect(() =>
      validateChallengeStages({
        stages: [
          stage({
            rank_rewards: [
              { rank: 2, credits: 1 },
              { rank: 2, credits: 2 },
            ],
          }),
        ],
      }),
    ).toThrow(/duplicate rank 2/);
  });

  it('rejects negative credits', () => {
    expect(() =>
      validateChallengeStages({
        stages: [stage({ rank_rewards: [{ rank: 1, credits: -1 }] })],
      }),
    ).toThrow(/credits must be between 0 and/);
  });

  it('accepts rank credits at the cap but rejects one above it', () => {
    expect(
      validateChallengeStages({
        stages: [
          stage({
            rank_rewards: [
              { rank: 1, credits: MAX_AGGREGATE_RANK_CREDITS_MYR },
            ],
          }),
        ],
      }),
    ).toHaveLength(1);
    expect(() =>
      validateChallengeStages({
        stages: [
          stage({
            rank_rewards: [
              { rank: 1, credits: MAX_AGGREGATE_RANK_CREDITS_MYR + 1 },
            ],
          }),
        ],
      }),
    ).toThrow(/credits must be between 0 and/);
  });

  // Regression: the per-stage cap used to be the RM 10,000 voucher ceiling,
  // which refused the operator's RM 18,000 rank-4 prize (2026-10-04). This is
  // the live ladder's rank 4-10 credits with that stage 4 appended.
  it('accepts the live ladder with an RM 18,000 rank-4 stage', () => {
    const credits = [
      [500, 300, 200, 80, 60, 50, 30],
      [1500, 500, 300, 200, 150, 100, 50],
      [5000, 1500, 800, 600, 500, 300, 150],
      [18000, 6000, 3000, 1800, 1500, 1000, 800],
    ];
    const stages = credits.map((row, i) =>
      stage({
        stage_number: i + 1,
        threshold_myr: [200_000, 500_000, 1_500_000, 5_000_000][i],
        rank_rewards: row.map((c, j) => ({
          rank: j + 4,
          card_id: null,
          credits: c,
        })),
      }),
    );
    expect(validateChallengeStages({ stages })[3].rank_rewards[0].credits).toBe(
      18000,
    );
  });

  it('rejects a rank whose credits sum past the aggregate cap across stages', () => {
    const half = MAX_AGGREGATE_RANK_CREDITS_MYR / 2;
    const stages = [1, 2, 3].map((n) =>
      stage({
        stage_number: n,
        threshold_myr: n * 100,
        rank_rewards: [{ rank: 4, card_id: null, credits: half }],
      }),
    );
    expect(() => validateChallengeStages({ stages })).toThrow(
      /rank 4 would be paid/,
    );
  });

  it('rejects non-finite thresholds and rank credits', () => {
    // NaN/Infinity survive a bare `typeof === number` and every `<`/`>`
    // range comparison, so only the Number.isFinite guards catch them.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() =>
        validateChallengeStages({ stages: [stage({ threshold_myr: bad })] }),
      ).toThrow(/threshold_myr must be >= 0/);
      expect(() =>
        validateChallengeStages({
          stages: [stage({ rank_rewards: [{ rank: 1, credits: bad }] })],
        }),
      ).toThrow(/credits must be between 0 and/);
    }
  });

  it('rejects a malformed rank_rewards table or card_id', () => {
    expect(() =>
      validateChallengeStages({ stages: [stage({ rank_rewards: 'x' })] }),
    ).toThrow(/must be an array of rank rewards/);
    expect(() =>
      validateChallengeStages({ stages: [stage({ rank_rewards: [1] })] }),
    ).toThrow(/each entry must be an object/);
    expect(() =>
      validateChallengeStages({
        stages: [stage({ rank_rewards: [{ rank: 1, card_id: '  ' }] })],
      }),
    ).toThrow(/card_id must be a non-empty card id or null/);
  });
});

describe('validateChallengeSettingsPatch', () => {
  it('accepts a partial patch of valid fields', () => {
    const out = validateChallengeSettingsPatch({
      patch: { timezone: 'Asia/Kuala_Lumpur', reset_day: 1, reset_hour: 0 },
    });
    expect(out).toEqual({
      timezone: 'Asia/Kuala_Lumpur',
      reset_day: 1,
      reset_hour: 0,
    });
  });

  it('rejects an invalid cadence', () => {
    expect(() =>
      validateChallengeSettingsPatch({ patch: { cadence: 'rolling' } }),
    ).toThrow(/cadence must be 'fixed_weekly'/);
  });

  it('rejects a bad timezone', () => {
    expect(() =>
      validateChallengeSettingsPatch({ patch: { timezone: 'Mars/Olympus' } }),
    ).toThrow(/valid IANA time zone/);
  });

  it('rejects out-of-range reset_day / reset_hour', () => {
    expect(() =>
      validateChallengeSettingsPatch({ patch: { reset_day: 7 } }),
    ).toThrow(/reset_day must be an integer 0.6/);
    expect(() =>
      validateChallengeSettingsPatch({ patch: { reset_hour: 24 } }),
    ).toThrow(/reset_hour must be an integer 0.23/);
  });

  it('rejects a retired payout-only patch and an empty patch', () => {
    // payout fields are retired (stages are the prize pool) — the validator now
    // ignores them, so a payout-only patch has no valid fields to update.
    expect(() =>
      validateChallengeSettingsPatch({
        patch: { payout_credits: 50, payout_card_ids: ['card_1'] },
      }),
    ).toThrow(/No valid settings/);
    expect(() => validateChallengeSettingsPatch({ patch: {} })).toThrow(
      /No valid settings/,
    );
  });
});
