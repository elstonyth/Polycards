import { model } from '@medusajs/framework/utils';

// One row per Weekly-Challenge milestone stage (inert config sub-project D
// reads). stage_number is contiguous from 1 (unique). threshold_myr is the
// community-pool cumulative threshold in MYR. rank_rewards is the per-rank
// prize table (plan 057): a SPARSE array of
// `{ rank: 1..10, card_id: string | null, credits: number }` — each rank may
// carry a featured `card` id and/or MYR store credits (1 RM = 1 credit).
// Ranks absent from the array pay nothing.
export const ChallengeStage = model
  .define('challenge_stage', {
    id: model.id().primaryKey(),
    stage_number: model.number().unique(),
    threshold_myr: model.bigNumber(),
    rank_rewards: model.json(),
  })
  .indexes([
    {
      name: 'IDX_challenge_stage_stage_number',
      on: ['stage_number'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default ChallengeStage;
