import {
  createStep,
  StepResponse,
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import type { RewardPoolEntry } from '../modules/packs/reward-pool-validate';

export type SaveRewardPoolInput = {
  /** VIP box_tier key, e.g. 'c'. The reward_box Pack slug = 'reward-box-<tier>'. */
  tier: string;
  entries: RewardPoolEntry[];
  draws_per_day: number;
  pool_enabled: boolean;
  /** Server-derived admin actor id — never from the request body. */
  admin_id: string;
};

export type SaveRewardPoolResult = {
  pack_slug: string;
  entries_count: number;
  draws_per_day: number;
  pool_enabled: boolean;
};

// save-reward-pool-step — upsert the tier's reward_box Pack, atomically
// replace-all its reward PackOdds rows + pool config (one transaction inside
// packs.replaceRewardPool), then write an admin_action_audit row.
//
// No compensation: the destructive part (delete → insert → update odds/pack
// config) is atomic in replaceRewardPool's injected transaction, so a partial
// failure rolls itself back. There are no downstream steps after this one, so a
// rollback function would never fire — it was only ever "best-effort" cosmetics.
const saveRewardPoolStep = createStep(
  'save-reward-pool',
  async (input: SaveRewardPoolInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const slug = `reward-box-${input.tier}`;

    // Resolve or create the reward_box Pack for this tier.
    const [existing] = await packs.listPacks({ slug }, { take: 1 });
    let pack: {
      slug: string;
      pool_enabled: boolean;
      draws_per_day: number;
      id: string;
    };

    if (existing) {
      pack = existing as typeof pack;
    } else {
      // Create a dormant shell; the caller controls pool_enabled.
      const [created] = await packs.createPacks([
        {
          slug,
          title: `VIP Reward Box – Tier ${input.tier.toUpperCase()}`,
          category: 'reward_box',
          price: 0,
          image: '/images/reward-box-placeholder.webp',
          status: 'active' as const,
          pool_enabled: false,
          draws_per_day: 0,
        },
      ]);
      pack = created as typeof pack;
    }

    // Prior reward odds ids (card_id null) — the replace-all targets only these.
    const priorOdds = await packs.listPackOdds(
      { pack_id: slug },
      { take: 10000 },
    );
    const priorRewardOddsIds = priorOdds
      .filter((o) => o.card_id == null)
      .map((o) => o.id);
    const priorPoolEnabled = pack.pool_enabled;
    const priorDrawsPerDay = pack.draws_per_day;

    // Atomic replace-all: delete prior reward odds, insert the new set, update
    // the Pack's pool config — all in one transaction (rolls back together).
    await packs.replaceRewardPool({
      slug,
      priorOddsIds: priorRewardOddsIds,
      newEntries: input.entries,
      pool_enabled: input.pool_enabled,
      draws_per_day: input.draws_per_day,
    });

    // Admin audit row.
    await packs.createAdminActionAudits([
      {
        admin_id: input.admin_id,
        entity_type: 'reward_pool',
        entity_id: slug,
        action: 'edit_reward_pool',
        before: {
          pool_enabled: priorPoolEnabled,
          draws_per_day: priorDrawsPerDay,
          entries_count: priorRewardOddsIds.length,
        },
        after: {
          pool_enabled: input.pool_enabled,
          draws_per_day: input.draws_per_day,
          entries_count: input.entries.length,
        },
        reason: `Admin updated reward pool for tier ${input.tier}`,
      },
    ]);

    const result: SaveRewardPoolResult = {
      pack_slug: slug,
      entries_count: input.entries.length,
      draws_per_day: input.draws_per_day,
      pool_enabled: input.pool_enabled,
    };

    return new StepResponse(result);
  },
);

export const saveRewardPoolWorkflow = createWorkflow(
  'save-reward-pool',
  function (input: SaveRewardPoolInput) {
    const result = saveRewardPoolStep(input);
    return new WorkflowResponse(result);
  },
);

export default saveRewardPoolWorkflow;
