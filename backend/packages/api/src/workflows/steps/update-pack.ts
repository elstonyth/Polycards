import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { hasRollablePool } from '../../modules/packs/rollable-pool';
import type { PackWriteInput, PublishedOdds } from './create-pack';

// slug is immutable (it keys PackOdds / the /claw route); it selects the row.
export type UpdatePackInput = PackWriteInput;

type PackSnapshot = {
  id: string;
  title: string;
  category: string;
  price: number;
  image: string;
  buyback_percent: number;
  boost: boolean;
  rank: number;
  status: 'active' | 'draft';
  published_odds: PublishedOdds | null;
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
      buyback_percent: pack.buyback_percent,
      boost: pack.boost,
      rank: pack.rank,
      status: pack.status,
      published_odds: (pack.published_odds as PublishedOdds | null) ?? null,
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
        // (the list-page edit modal doesn't know about published odds).
        ...(input.published_odds !== undefined
          ? { published_odds: input.published_odds }
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
