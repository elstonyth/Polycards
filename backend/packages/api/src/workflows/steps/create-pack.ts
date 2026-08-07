import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { RARITIES, type OddsRarity, type TierRangeMap } from '@acme/odds-math';
import { fillTierRanges } from '../../modules/packs/tier-settings-validate';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

// PUBLIC display odds ({ overall win %, per-tier % }) shown to players —
// completely decoupled from the secret PackOdds weights driving the draw.
export type PublishedOdds = {
  overall: number;
  tiers: Partial<Record<OddsRarity, number>>;
  /** Decimal places the tier percentages are published at (0-4). Purely a
   *  display/authoring precision: the validator rounds every tier to this many
   *  places on save, so the storefront prints stored values verbatim. */
  decimals: number;
};

// Sparse tiers → the full-key WRITE shape (null = tier not published). The
// ORM MERGES json POJOs on update, so an UPDATE writing published_odds must
// carry every rarity key or a removed tier resurrects from the stored value —
// the same bug class as pack.tier_ranges (fillTierRanges). Reads strip the
// nulls back out via normalizePublishedOdds below.
export const fillPublishedTiers = (
  tiers: PublishedOdds['tiers'],
): Record<string, number | null> => {
  const full: Record<string, number | null> = {};
  for (const r of RARITIES) full[r] = tiers[r] ?? null;
  return full;
};

// Stored jsonb → the public { overall, tiers } shape: storage nulls and
// non-numeric noise dropped, unknown keys ignored. Every route that serves
// published_odds runs this, so no consumer ever sees the null-filled storage
// shape (the admin editor seeds inputs with String(tiers[r]), and "null" in a
// win-rate field is exactly the garbage this prevents).
/** Pre-decimals rows have no 'decimals' key — they were authored at the old
 *  hard-coded 2-place rounding, so 2 is the faithful default. */
export const PUBLISHED_DECIMALS_DEFAULT = 2;
export const MAX_PUBLISHED_DECIMALS = 4;

export const normalizePublishedOdds = (raw: unknown): PublishedOdds | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { overall?: unknown; tiers?: unknown; decimals?: unknown };
  const overall =
    typeof o.overall === 'number' && Number.isFinite(o.overall)
      ? o.overall
      : 100;
  const tiers: PublishedOdds['tiers'] = {};
  const stored = (o.tiers ?? {}) as Record<string, unknown>;
  for (const r of RARITIES) {
    const v = stored[r];
    if (typeof v === 'number' && Number.isFinite(v)) tiers[r] = v;
  }
  const decimals =
    typeof o.decimals === 'number' &&
    Number.isInteger(o.decimals) &&
    o.decimals >= 0 &&
    o.decimals <= MAX_PUBLISHED_DECIMALS
      ? o.decimals
      : PUBLISHED_DECIMALS_DEFAULT;
  return { overall, tiers, decimals };
};

export type PackWriteInput = {
  slug: string;
  title: string;
  category: string;
  price: number;
  image: string;
  // Optional pack-page hero (wide stage/"factory" render). Tri-state like
  // published_odds: undefined = leave as-is (writers that don't send the field
  // must not clear it); null = explicit clear — the stage falls back to `image`.
  display_image?: string | null;
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
  // Per-pack tier price-range override. Tri-state like published_odds:
  // undefined = leave as-is; null = clear (inherit the global tier_settings);
  // map = pack-specific ranges.
  tier_ranges?: TierRangeMap | null;
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
        display_image: input.display_image ?? null,
        buyback_percent: input.buyback_percent,
        boost: input.boost,
        rank: input.rank,
        status: input.status,
        // Full-key shapes from birth (see fillPublishedTiers/fillTierRanges):
        // an insert has no merge hazard itself, but a sparse stored map makes
        // every LATER update/rollback merge-prone — store only null or the
        // full-key form so the invariant holds everywhere.
        published_odds: (input.published_odds == null
          ? null
          : {
              overall: input.published_odds.overall,
              tiers: fillPublishedTiers(input.published_odds.tiers),
              decimals: input.published_odds.decimals,
            }) as unknown as Record<string, unknown> | null,
        tier_ranges: (input.tier_ranges == null
          ? null
          : fillTierRanges(input.tier_ranges)) as unknown as Record<
          string,
          unknown
        > | null,
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
