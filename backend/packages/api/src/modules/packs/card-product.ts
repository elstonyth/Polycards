import { Modules, ProductStatus, MedusaError } from '@medusajs/framework/utils';
import { MercurModules } from '@mercurjs/types';
import type {
  CreateProductWorkflowInputDTO,
  MedusaContainer,
} from '@medusajs/framework/types';

// Shared builder for the "card -> marketplace Product" mirror.
//
// A gacha Card and its standalone marketplace listing are ONE logical entity
// keyed by `handle` (Card.handle === Product.handle). Both the seed (which mass-
// creates the initial catalog) and the admin card mirror (create/edit) must
// produce the EXACT same Product shape, or the two drift apart. So the structural
// shape — variant/sku/options/currency/images — lives here once. Only the
// metadata *content* and a couple of flags vary per caller and are passed in.

// NOTE: rarity is deliberately absent — it is a per-pack property (PackOdds),
// not a card/product fact, so it never belongs in product metadata.
export type CardProductMetadata = {
  fmv: number;
  points: number;
  grade: string;
  grader: string;
  set: string;
  year: number;
  // Optional PriceCharting link — present only for products minted from a
  // PriceCharting lookup (Add-from-PriceCharting). Absent for seeded/manual
  // cards, so their product metadata is unchanged.
  pc_product_id?: string;
  pc_grade?: string;
  market_multiplier?: number;
  // Optional pixel-Pokémon staging (Add-from-PriceCharting) — inherited by
  // create-card when the product is registered as a gacha card.
  pokemon_dex?: number;
  sprite_image?: string;
};

export type CardProductSeed = {
  handle: string;
  title: string;
  image: string;
  price: number; // MYR listing price (decimal, stored as-is — never cents)
  metadata: CardProductMetadata;
};

export type CardProductContext = {
  sellerId: string;
  shippingProfileId: string;
  salesChannelId: string;
  stockLocationId: string;
};

export type BuildOptions = {
  shippingProfileId: string;
  salesChannelId: string;
  status: ProductStatus;
  // Seeded products track inventory (the seed creates 1M-stock levels for each).
  // Admin-mirrored standalone listings default to untracked (display-only
  // marketplace, no checkout yet) so the mirror needs no inventory-level step.
  manageInventory: boolean;
};

// Minimal structural view of Mercur's SELLER module service. Mercur ships no
// public type for it, so `container.resolve(MercurModules.SELLER)` is `unknown`;
// this types the two methods the house-seller code paths actually call (here, in
// create-card, and in the seed).
export interface HouseSellerService {
  listSellers: (filter: { handle: string }) => Promise<Array<{ id: string }>>;
  createSellers: (data: unknown[]) => Promise<Array<{ id: string }>>;
}

// Build a single product entry for createProductsWorkflow — the seed and the
// admin mirror both go through this so the catalog stays uniform.
export function buildCardProductInput(
  card: CardProductSeed,
  opts: BuildOptions,
): CreateProductWorkflowInputDTO {
  return {
    title: card.title,
    handle: card.handle,
    status: opts.status,
    shipping_profile_id: opts.shippingProfileId,
    thumbnail: card.image,
    images: [{ url: card.image }],
    options: [{ title: 'Format', values: ['Slab'] }],
    variants: [
      {
        title: 'Slab',
        sku: `CARD-${card.handle.toUpperCase()}`,
        manage_inventory: opts.manageInventory,
        options: { Format: 'Slab' },
        prices: [{ currency_code: 'myr', amount: card.price }],
      },
    ],
    sales_channels: [{ id: opts.salesChannelId }],
    metadata: {
      fmv: card.metadata.fmv,
      points: card.metadata.points,
      grade: card.metadata.grade,
      grader: card.metadata.grader,
      set: card.metadata.set,
      year: card.metadata.year,
      ...(card.metadata.pc_product_id !== undefined
        ? { pc_product_id: card.metadata.pc_product_id }
        : {}),
      ...(card.metadata.pc_grade !== undefined
        ? { pc_grade: card.metadata.pc_grade }
        : {}),
      ...(card.metadata.market_multiplier !== undefined
        ? { market_multiplier: card.metadata.market_multiplier }
        : {}),
      ...(card.metadata.pokemon_dex !== undefined
        ? { pokemon_dex: card.metadata.pokemon_dex }
        : {}),
      ...(card.metadata.sprite_image !== undefined
        ? { sprite_image: card.metadata.sprite_image }
        : {}),
    },
  };
}

// Resolve the single-store context the mirror needs (house seller + the default
// sales channel / shipping profile / stock location). Single-operator store, so
// "the default / first of each" is correct — it mirrors how the seed resolves
// them. Throws if the store has not been seeded yet (no house seller etc.).
export async function resolveCardProductContext(
  container: MedusaContainer,
): Promise<CardProductContext> {
  const sellerService = container.resolve<HouseSellerService>(
    MercurModules.SELLER,
  );
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL);
  const fulfillmentService = container.resolve(Modules.FULFILLMENT);
  const stockLocationService = container.resolve(Modules.STOCK_LOCATION);

  const [houseSeller] = await sellerService.listSellers({ handle: 'house' });
  if (!houseSeller) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'House seller not found — run the seed before managing the catalog.',
    );
  }

  const namedChannels = await salesChannelService.listSalesChannels(
    { name: 'Default Sales Channel' },
    { take: 1 },
  );
  const [salesChannel] = namedChannels.length
    ? namedChannels
    : await salesChannelService.listSalesChannels({}, { take: 1 });
  if (!salesChannel) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No sales channel found — run the seed before managing the catalog.',
    );
  }

  const [shippingProfile] = await fulfillmentService.listShippingProfiles(
    {},
    { take: 1 },
  );
  if (!shippingProfile) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No shipping profile found — run the seed before managing the catalog.',
    );
  }

  const [stockLocation] = await stockLocationService.listStockLocations(
    {},
    { take: 1 },
  );
  if (!stockLocation) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No stock location found — run the seed before managing the catalog.',
    );
  }

  return {
    sellerId: houseSeller.id,
    shippingProfileId: shippingProfile.id,
    salesChannelId: salesChannel.id,
    stockLocationId: stockLocation.id,
  };
}
