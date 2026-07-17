import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { DEFAULT_MARKET_MULTIPLIER } from '../../modules/packs/pricing';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import { MercurModules } from '@mercurjs/types';
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { resolvePixelPokemonPatch } from '../../modules/packs/card-pixel-pokemon';
import type { HouseSellerService } from '../../modules/packs/card-product';
import { insertOrMapDuplicate } from './duplicate-race';
import {
  bakeSlabImage,
  deleteSlabFile,
} from '../../api/admin/media/bake-slab';

// Inventory-first registration: the PRODUCT is the item, created in the product
// catalog beforehand. Registering it as a gacha Card only records the gacha
// facts (FMV, set, grader, grade) — name/image/handle are READ from the product,
// never entered twice. Rarity is NOT set here: it is chosen per pack when the
// card joins a prize pool (PackOdds.rarity).
export type RegisterCardInput = {
  product_id: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number; // USD FMV — a decimal, never cents
  // Spec 2 §5: the Pokémon is assigned by a PixelPokemon library id (the picker),
  // not raw dex/sprite — the step resolves the id → the mirrored dex/sprite_image
  // columns. undefined = not provided (inherit the id staged on the product's
  // metadata by /from-pricecharting); null = explicitly none; string = link it.
  pixel_pokemon_id?: string | null;
  // PriceCharting linkage — optional; when omitted, inherited from the
  // product's own metadata (set by /admin/products/from-pricecharting).
  pc_product_id?: string | null;
  pc_grade?: string | null;
  market_multiplier?: number;
  // Graded-slab label extras (§8). undefined = inherit the value staged on the
  // product's metadata by /from-pricecharting (like pc_product_id above).
  label_year?: string | null;
  label_note?: string | null;
};

type CompensateData =
  | {
      cardId: string;
      productId: string;
      prevMetadata: Record<string, unknown>;
    }
  | undefined;

// create-card — register an existing catalog Product as a gacha Card. Creates
// ONLY the Card row (handle === Product.handle, the shared business key) and
// mirrors the gacha facts onto the product's metadata so the marketplace detail
// page can show FMV/grade. The product itself is never created or deleted here.
//
// The invoke handler is a named export so the unit suite can drive it with a
// stubbed container: the duplicate-registration RACE branch (pre-check passes,
// then the handle's UNIQUE constraint throws) cannot be triggered
// deterministically through the HTTP harness.
export const registerCardInvoke = async (
  input: RegisterCardInput,
  { container }: { container: MedusaContainer },
) => {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const productModule = container.resolve(Modules.PRODUCT);

  const [product] = await productModule.listProducts(
    { id: input.product_id },
    { take: 1, relations: ['images'] },
  );
  if (!product) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Product '${input.product_id}' not found — add the item to the inventory first.`,
    );
  }
  if (!product.handle) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Product '${input.product_id}' has no handle.`,
    );
  }

  const image = product.thumbnail ?? product.images?.[0]?.url ?? '';
  if (!image) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Product '${product.title}' has no image — upload one on the product before registering it as a card.`,
    );
  }

  const alreadyRegistered = () =>
    new MedusaError(
      MedusaError.Types.DUPLICATE_ERROR,
      `'${product.title}' is already registered as a gacha card.`,
    );

  // Handle is the unique business key shared by Card + Product + PackOdds.
  // This pre-check is advisory (it keeps the common duplicate case cheap and
  // friendly); two concurrent registrations both pass it, so the insert below
  // also maps the handle UNIQUE constraint's violation to the same error.
  const [existingCard] = await packs.listCards(
    { handle: product.handle },
    { take: 1 },
  );
  if (existingCard) {
    throw alreadyRegistered();
  }

  // Inherit the PriceCharting link from the product's own metadata (set by
  // /admin/products/from-pricecharting) unless the caller explicitly overrides
  // it. A plain (non-PC) product leaves these null/default — untracked.
  const meta = (product.metadata ?? {}) as Record<string, unknown>;
  const pcProductId =
    input.pc_product_id ??
    (typeof meta.pc_product_id === 'string' ? meta.pc_product_id : null);
  const pcGrade =
    input.pc_grade ??
    (typeof meta.pc_grade === 'string' ? meta.pc_grade : null);
  const mult =
    input.market_multiplier ??
    (Number.isFinite(Number(meta.market_multiplier))
      ? Number(meta.market_multiplier)
      : DEFAULT_MARKET_MULTIPLIER);
  const stagedLabel = (k: 'label_year' | 'label_note'): string | null =>
    typeof meta[k] === 'string' && (meta[k] as string).trim() !== ''
      ? (meta[k] as string)
      : null;
  const labelYear = input.label_year ?? stagedLabel('label_year');
  const labelNote = input.label_note ?? stagedLabel('label_note');

  // Graded PSA card → bake the slab composite BEFORE the insert so the slab
  // fields ride the single createCards write and the product-metadata mirror
  // below. Non-PSA graders skip inside bakeSlabImage (§9). Best-effort: a
  // failed bake registers the card with a bare photo (nulls).
  const baked = await bakeSlabImage(container, {
    handle: product.handle,
    image,
    grader: input.grader,
    grade: input.grade,
    name: product.title,
    set: input.set,
    label_year: labelYear,
    label_note: labelNote,
  });

  // Pixel-Pokémon assignment staged at product creation (from-pricecharting)
  // is inherited the same way — an explicit pick in the register dialog wins.
  // The register dialog sends a PixelPokemon library id: undefined = not picked
  // (inherit the staged id), null = explicitly none, string = link it. The
  // link's dex + image_url are then MIRRORED onto the card's render-cache
  // columns so the storefront resolver is unchanged.
  const stagedPixelId =
    typeof meta.pixel_pokemon_id === 'string' &&
    meta.pixel_pokemon_id.trim() !== ''
      ? meta.pixel_pokemon_id
      : null;
  // An EXPLICIT pick in the register dialog hard-fails on a bad id (the operator
  // can fix it). An INHERITED staged id is best-effort: a custom library entry
  // can be deleted (PR #116), so a since-gone staged id must NOT block
  // registration — degrade to name-derivation (unlinked) instead.
  let pixelPatch;
  if (input.pixel_pokemon_id !== undefined) {
    pixelPatch = await resolvePixelPokemonPatch(packs, input.pixel_pokemon_id);
  } else {
    try {
      pixelPatch = await resolvePixelPokemonPatch(packs, stagedPixelId);
    } catch (error) {
      // ONLY a genuinely-missing staged id degrades to unlinked. A real runtime
      // failure (e.g. the asPixelPokemonCrud singular/plural bridge breaking —
      // tsc can't catch that) must surface loudly, like the explicit path — not
      // silently register every inherited card unlinked.
      if (
        !(
          error instanceof MedusaError &&
          error.type === MedusaError.Types.NOT_FOUND
        )
      ) {
        throw error;
      }
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `create-card: staged pixel_pokemon_id '${stagedPixelId}' did not resolve — registering unlinked (name-derivation). ${error.message}`,
        );
      pixelPatch = await resolvePixelPokemonPatch(packs, null);
    }
  }

  const [card] = await insertOrMapDuplicate({
    insert: () =>
      packs.createCards([
        {
          handle: product.handle,
          name: product.title,
          set: input.set,
          grader: input.grader,
          grade: input.grade,
          market_value: input.market_value,
          image,
          // NULL price = "use FMV"; the product's own variant price stays the
          // marketplace source of truth and is not touched by registration.
          price: null,
          for_sale: product.status === 'published',
          pixel_pokemon_id: pixelPatch.pixel_pokemon_id ?? null,
          pokemon_dex: pixelPatch.pokemon_dex ?? null,
          sprite_image: pixelPatch.sprite_image ?? null,
          slab_image: baked?.url ?? null,
          slab_image_key: baked?.key ?? null,
          pc_product_id: pcProductId,
          pc_grade: pcGrade,
          market_multiplier: mult,
          label_year: labelYear,
          label_note: labelNote,
        },
      ]),
    probeDuplicate: async () => {
      const [raced] = await packs.listCards(
        { handle: product.handle },
        { take: 1 },
      );
      return raced !== undefined;
    },
    duplicateError: alreadyRegistered,
    logger: container.resolve(ContainerRegistrationKeys.LOGGER),
    label: 'create-card',
  });

  // Mirror the gacha facts onto the product metadata (the marketplace card
  // page reads fmv/grade/grader/set from there) and make sure the product is
  // LINKED to the house seller — Mercur's storefront product middleware hides
  // seller-less products, so a hand-created catalog product would otherwise
  // never show on /marketplace even when published. If any of this fails,
  // undo the Card so the step is atomic (StepResponse compensation only
  // covers later steps). The seller link is intentionally NOT compensated:
  // every catalog product belongs to the house seller in this single-vendor
  // store, so a kept link is the desired end state regardless.
  const prevMetadata = (product.metadata ?? {}) as Record<string, unknown>;
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data: withSeller } = await query.graph({
      entity: 'product',
      fields: ['id', 'seller.id'],
      filters: { id: product.id },
    });
    if (!withSeller[0]?.seller?.id) {
      const sellerService = container.resolve<HouseSellerService>(
        MercurModules.SELLER,
      );
      const [houseSeller] = await sellerService.listSellers({
        handle: 'house',
      });
      if (!houseSeller) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          'House seller not found — run the seed before managing the catalog.',
        );
      }
      const link = container.resolve(ContainerRegistrationKeys.LINK);
      await link.create({
        [Modules.PRODUCT]: { product_id: product.id },
        [MercurModules.SELLER]: { seller_id: houseSeller.id },
      });
    }
    await updateProductsWorkflow(container).run({
      input: {
        products: [
          {
            id: product.id,
            metadata: {
              ...prevMetadata,
              fmv: input.market_value,
              points:
                typeof prevMetadata.points === 'number'
                  ? prevMetadata.points
                  : 0,
              grade: input.grade,
              grader: input.grader,
              set: input.set,
              // Public mirror for the marketplace listing (Products, not
              // Cards). URL only — slab_image_key is a private provider handle.
              slab_image: baked?.url ?? null,
              year:
                typeof prevMetadata.year === 'number'
                  ? prevMetadata.year
                  : new Date().getFullYear(),
            },
          },
        ],
      },
    });
  } catch (error) {
    // The just-uploaded composite is referenced only by the Card row being
    // undone here — reclaim it too (deleteSlabFile never throws), so a failed
    // mirror doesn't orphan one file per retried registration.
    if (baked) {
      await deleteSlabFile(container, baked.key);
    }
    await packs.deleteCards([card.id]);
    throw error;
  }

  return new StepResponse({ handle: card.handle, productId: product.id }, {
    cardId: card.id,
    productId: product.id,
    prevMetadata,
  } satisfies CompensateData);
};

export const createCardStep = createStep(
  'create-card',
  registerCardInvoke,
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCards([data.cardId]);
    await updateProductsWorkflow(container).run({
      input: {
        products: [{ id: data.productId, metadata: data.prevMetadata }],
      },
    });
  },
);

export default createCardStep;
