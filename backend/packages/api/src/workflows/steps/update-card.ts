import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { DEFAULT_MARKET_MULTIPLIER } from '../../modules/packs/pricing';
import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError, ProductStatus, Modules } from '@medusajs/framework/utils';
import {
  createProductsWorkflow,
  updateProductsWorkflow,
} from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  buildCardProductInput,
  resolveCardProductContext,
} from '../../modules/packs/card-product';
import { bakeSlabImage, deleteSlabFile } from '../../api/admin/media/bake-slab';

// Everything about a card is editable EXCEPT its handle (the immutable key that
// PackOdds / Pull / the Product reference). `handle` selects the row to patch.
// Rarity is NOT here — it is a per-pack property (PackOdds.rarity), edited in
// the pack's win-rate editor.
export type UpdateCardInput = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  image: string;
  // Standalone sale price. Falls back to market_value (FMV) when omitted.
  price?: number;
  // Listed on the marketplace (mirrored Product PUBLISHED) vs pack-only (DRAFT).
  for_sale: boolean;
  pokemon_dex: number | null;
  sprite_image: string | null;
  // PriceCharting linkage — optional. Omitted/undefined defaults to
  // null/1.2 below (NOT "leave as-is"); the edit form round-trips the card's
  // current values from GET so a save that doesn't touch PC linkage still
  // preserves it in practice.
  pc_product_id?: string | null;
  pc_grade?: string | null;
  market_multiplier?: number;
};

type CardSnapshot = {
  id: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  image: string;
  price: number | null;
  for_sale: boolean;
  pokemon_dex: number | null;
  sprite_image: string | null;
  pc_product_id: string | null;
  pc_grade: string | null;
  market_multiplier: number;
  slab_image: string | null;
  slab_image_key: string | null;
};

type ProductSnapshot = {
  id: string;
  title: string;
  status: string;
  thumbnail: string | null;
  images: { url: string }[];
  metadata: Record<string, unknown>;
  variantId: string | null;
};

// The non-undefined compensate shape both invoke branches return. Kept
// separate from CompensateData (below) — `satisfies`-ing each branch against
// this exact type (not the `| undefined` union) is what lets TS infer a
// single concrete TCompensateInput for createStep instead of a union that
// distributes over `undefined` (InvokeFn's `TCompensateInput extends
// undefined ? TOutput : TCompensateInput` — see create-step.d.ts).
type CardCompensate = { card: CardSnapshot; product: ProductSnapshot | null };
type CompensateData = CardCompensate | undefined;

// update-card — patch the Card row and bring its mirrored Product back in sync:
// update title/image/metadata/price and flip PUBLISHED<->DRAFT to match for_sale.
// Upsert: if the Product is somehow missing it is (re)created. Compensation
// restores the prior Card AND the full prior Product state.
export const updateCardInvoke = async (
  input: UpdateCardInput,
  { container }: { container: MedusaContainer },
): Promise<
  StepResponse<{ handle: string; productId: string }, CardCompensate>
> => {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const productModule = container.resolve(Modules.PRODUCT);

  const [card] = await packs.listCards({ handle: input.handle }, { take: 1 });
  if (!card) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Card '${input.handle}' not found.`,
    );
  }

  const snapshot: CardSnapshot = {
    id: card.id,
    name: card.name,
    set: card.set,
    grader: card.grader,
    grade: card.grade,
    market_value: Number(card.market_value),
    image: card.image,
    price: card.price === null ? null : Number(card.price),
    for_sale: card.for_sale,
    pokemon_dex: card.pokemon_dex ?? null,
    sprite_image: card.sprite_image ?? null,
    pc_product_id: card.pc_product_id ?? null,
    pc_grade: card.pc_grade ?? null,
    market_multiplier: Number(
      card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
    ),
    slab_image: card.slab_image ?? null,
    slab_image_key: card.slab_image_key ?? null,
  };

  const salePrice = input.price ?? input.market_value;

  // Slab bake (spec §C): graded → re-bake on EVERY save (no dirty-check —
  // one composite per admin save is cheap and can never go stale when the
  // photo changes); grader emptied → clear. Best-effort: a failed bake
  // saves with nulls (bare photo).
  const baked =
    input.grader.trim() !== ''
      ? await bakeSlabImage(container, {
          handle: input.handle,
          image: input.image,
        })
      : null;
  const nextSlabImage = baked?.url ?? null;
  const nextSlabKey = baked?.key ?? null;

  await packs.updateCards([
    {
      id: card.id,
      name: input.name,
      set: input.set,
      grader: input.grader,
      grade: input.grade,
      market_value: input.market_value,
      image: input.image,
      // Store the operator's price verbatim — NULL means "use FMV" and must be
      // preserved (the Product mirror below still gets a concrete `salePrice`).
      price: input.price ?? null,
      for_sale: input.for_sale,
      pokemon_dex: input.pokemon_dex,
      sprite_image: input.sprite_image,
      slab_image: nextSlabImage,
      slab_image_key: nextSlabKey,
      pc_product_id: input.pc_product_id ?? null,
      pc_grade: input.pc_grade ?? null,
      market_multiplier: input.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
    },
  ]);

  // Mirror to the Product (handle === card.handle).
  const [product] = await productModule.listProducts(
    { handle: input.handle },
    { take: 1, relations: ['variants', 'images'] },
  );
  const nextStatus = input.for_sale
    ? ProductStatus.PUBLISHED
    : ProductStatus.DRAFT;

  if (product) {
    const variantId = product.variants?.[0]?.id ?? null;
    // Capture the full prior Product state so compensation restores everything,
    // not just status. The prior variant price isn't loaded here (it lives in a
    // price set); compensation restores it from the Card snapshot, since
    // Card.price and the Product variant price are kept in sync.
    const prevProduct: ProductSnapshot = {
      id: product.id,
      title: product.title,
      status: product.status,
      thumbnail: product.thumbnail ?? null,
      images: (product.images ?? []).map((im) => ({ url: im.url })),
      metadata: (product.metadata ?? {}) as Record<string, unknown>,
      variantId,
    };
    await updateProductsWorkflow(container).run({
      input: {
        products: [
          {
            id: product.id,
            title: input.name,
            status: nextStatus,
            thumbnail: input.image,
            images: [{ url: input.image }],
            metadata: {
              ...(product.metadata ?? {}),
              fmv: input.market_value,
              grade: input.grade,
              grader: input.grader,
              set: input.set,
              // Keep the PC-link mirror in sync with the card's new values —
              // the marketplace listing price reads market_multiplier off
              // product.metadata (src/lib/data/products.ts), so an edit here
              // must not leave it stale.
              pc_product_id: input.pc_product_id ?? null,
              pc_grade: input.pc_grade ?? null,
              market_multiplier:
                input.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
              slab_image: nextSlabImage,
            },
            ...(variantId
              ? {
                  variants: [
                    {
                      id: variantId,
                      prices: [{ currency_code: 'usd', amount: salePrice }],
                    },
                  ],
                }
              : {}),
          },
        ],
      },
    });
    // Old-composite cleanup (decision #8) — only after the new state is
    // fully written; skip when the key is unchanged or was never set.
    if (snapshot.slab_image_key && snapshot.slab_image_key !== nextSlabKey) {
      await deleteSlabFile(container, snapshot.slab_image_key);
    }
    return new StepResponse({ handle: card.handle, productId: product.id }, {
      card: snapshot,
      product: prevProduct,
    } satisfies CardCompensate);
  }

  // Defensive upsert: no Product for this handle — create one to match.
  const ctx = await resolveCardProductContext(container);
  const productInput = buildCardProductInput(
    {
      handle: input.handle,
      title: input.name,
      image: input.image,
      price: salePrice,
      metadata: {
        fmv: input.market_value,
        points: 0,
        grade: input.grade,
        grader: input.grader,
        set: input.set,
        year: new Date().getFullYear(),
        slab_image: nextSlabImage,
      },
    },
    {
      shippingProfileId: ctx.shippingProfileId,
      salesChannelId: ctx.salesChannelId,
      status: nextStatus,
      manageInventory: false,
    },
  );
  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [productInput],
      additional_data: { seller_id: ctx.sellerId },
    },
  });

  // Old-composite cleanup (decision #8) — only after the new state is
  // fully written; skip when the key is unchanged or was never set.
  if (snapshot.slab_image_key && snapshot.slab_image_key !== nextSlabKey) {
    await deleteSlabFile(container, snapshot.slab_image_key);
  }
  return new StepResponse({ handle: card.handle, productId: result[0].id }, {
    card: snapshot,
    product: null,
  } satisfies CardCompensate);
};

export const updateCardStep = createStep(
  'update-card',
  updateCardInvoke,
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updateCards([
      {
        id: data.card.id,
        name: data.card.name,
        set: data.card.set,
        grader: data.card.grader,
        grade: data.card.grade,
        market_value: data.card.market_value,
        image: data.card.image,
        price: data.card.price,
        for_sale: data.card.for_sale,
        pokemon_dex: data.card.pokemon_dex,
        sprite_image: data.card.sprite_image,
        slab_image: data.card.slab_image,
        slab_image_key: data.card.slab_image_key,
        pc_product_id: data.card.pc_product_id,
        pc_grade: data.card.pc_grade,
        market_multiplier: data.card.market_multiplier,
      },
    ]);
    if (data.product) {
      const p = data.product;
      await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: p.id,
              title: p.title,
              status: p.status as ProductStatus,
              thumbnail: p.thumbnail ?? undefined,
              images: p.images,
              metadata: p.metadata,
              ...(p.variantId
                ? {
                    variants: [
                      {
                        id: p.variantId,
                        prices: [
                          {
                            currency_code: 'usd',
                            amount: data.card.price ?? data.card.market_value,
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            },
          ],
        },
      });
    }
  },
);

export default updateCardStep;
