import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { hasRollablePool } from '../../modules/packs/rollable-pool';
import type { TierRangeMap } from '@acme/odds-math';
import { fillTierRanges } from '../../modules/packs/tier-settings-validate';
import {
  fillPublishedTiers,
  type PackWriteInput,
  type PublishedOdds,
} from './create-pack';

// slug is immutable (it keys PackOdds / the /claw route); it selects the row.
export type UpdatePackInput = PackWriteInput;

type PackSnapshot = {
  id: string;
  title: string;
  category: string;
  price: number;
  image: string;
  display_image: string | null;
  buyback_percent: number;
  boost: boolean;
  rank: number;
  status: 'active' | 'draft';
  published_odds: PublishedOdds | null;
  tier_ranges: TierRangeMap | null;
};

// update-pack — patch a pack's listing fields (everything but slug).
export const updatePackStep = createStep(
  'update-pack',
  async (input: UpdatePackInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [pack] = await packs.listPacks({ slug: input.slug }, { take: 1 });
    if (!pack) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pack '${input.slug}' not found.`,
      );
    }

    // Activating (or keeping active) requires a rollable prize pool — an active
    // pack with no positive-weight card odds fails every storefront spin.
    // reward_box packs are internal draw pools (reward rows, card_id null) and
    // are never opened via the pack path, so they are exempt.
    if (input.status === 'active' && input.category !== 'reward_box') {
      const rollable = await hasRollablePool(packs, input.slug);
      if (!rollable) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Pack '${input.slug}' has no cards in its prize pool. ` +
            'Add cards and set win rates on the pack page, then activate it.',
        );
      }
    }

    const snapshot: PackSnapshot = {
      id: pack.id,
      title: pack.title,
      category: pack.category,
      price: pack.price,
      image: pack.image,
      display_image: pack.display_image ?? null,
      buyback_percent: pack.buyback_percent,
      boost: pack.boost,
      rank: pack.rank,
      status: pack.status,
      published_odds: (pack.published_odds as PublishedOdds | null) ?? null,
      tier_ranges: (pack.tier_ranges as TierRangeMap | null) ?? null,
    };

    await packs.updatePacks([
      {
        id: pack.id,
        title: input.title,
        category: input.category,
        price: input.price,
        image: input.image,
        buyback_percent: input.buyback_percent,
        boost: input.boost,
        rank: input.rank,
        status: input.status,
        // undefined = the writer didn't send the field — keep the stored value
        // (the list-page edit modal doesn't know about published odds; an older
        // admin bundle doesn't know about display_image).
        ...(input.display_image !== undefined
          ? { display_image: input.display_image }
          : {}),
        // Same merge hazard as tier_ranges below: the tiers POJO must carry
        // EVERY rarity key (null = not published) or a removed tier survives
        // the update. Serving routes normalize the nulls back out.
        ...(input.published_odds !== undefined
          ? {
              published_odds:
                input.published_odds === null
                  ? null
                  : ({
                      overall: input.published_odds.overall,
                      tiers: fillPublishedTiers(input.published_odds.tiers),
                    } as unknown as Record<string, unknown>),
            }
          : {}),
        // A map is written with EVERY rarity key (null = unconfigured):
        // the ORM merges json POJOs on update, so a sparse map over a stored
        // one would resurrect removed tiers — shrinking or emptying an
        // override could never persist. Null (= inherit global) replaces
        // wholesale and needs no fill. Reads normalize the nulls back out.
        ...(input.tier_ranges !== undefined
          ? {
              tier_ranges:
                input.tier_ranges === null
                  ? null
                  : (fillTierRanges(input.tier_ranges) as unknown as Record<
                      string,
                      unknown
                    >),
            }
          : {}),
      },
    ]);

    return new StepResponse({ slug: pack.slug }, snapshot);
  },
  async (snapshot: PackSnapshot | undefined, { container }) => {
    if (!snapshot) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updatePacks([snapshot]);
  },
);

export default updatePackStep;
