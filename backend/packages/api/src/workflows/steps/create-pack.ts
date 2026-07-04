import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import type { OddsRarity } from '@acme/odds-math';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

// PUBLIC display odds ({ overall win %, per-tier % }) shown to players —
// completely decoupled from the secret PackOdds weights driving the draw.
export type PublishedOdds = {
  overall: number;
  tiers: Partial<Record<OddsRarity, number>>;
};

export type PackWriteInput = {
  slug: string;
  title: string;
  category: string;
  price: number;
  image: string;
  // Instant sell-back rate (% of FMV) at the reveal, within the post-pull
  // window; later sells from the vault are always at the flat rate — see
  // modules/packs/buyback-rate.ts.
  buyback_percent: number;
  boost: boolean;
  rank: number;
  status: 'active' | 'draft';
  // undefined = leave as-is (writers that don't send the field, e.g. the
  // list-page edit modal, must not clear it); null = explicit clear.
  published_odds?: PublishedOdds | null;
};

type CompensateData = { packId: string } | undefined;

// create-pack — create a gacha Pack listing. A new pack has an EMPTY prize pool
// (no PackOdds yet); cards are assigned via the membership editor. Compensation
// deletes the created pack.
export const createPackStep = createStep(
  'create-pack',
  async (input: PackWriteInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    // A new pack's prize pool is empty by construction, so an active creation
    // could never be opened — every storefront spin would fail. Enforce the
    // draft → assign cards → activate lifecycle.
    if (input.status === 'active') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'A new pack starts with an empty prize pool and cannot be active. ' +
          'Create it as a draft, add cards on the pack page, then activate it.',
      );
    }

    const [existing] = await packs.listPacks({ slug: input.slug }, { take: 1 });
    if (existing) {
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `A pack with slug '${input.slug}' already exists.`,
      );
    }

    const [pack] = await packs.createPacks([
      {
        slug: input.slug,
        title: input.title,
        category: input.category,
        price: input.price,
        image: input.image,
        buyback_percent: input.buyback_percent,
        boost: input.boost,
        rank: input.rank,
        status: input.status,
        published_odds: input.published_odds ?? null,
      },
    ]);

    return new StepResponse({ slug: pack.slug }, {
      packId: pack.id,
    } satisfies CompensateData);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deletePacks([data.packId]);
  },
);

export default createPackStep;
