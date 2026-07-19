import { CreateInventoryLevelInput, ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  deleteProductsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresStep,
  updateStoresWorkflow,
} from '@medusajs/medusa/core-flows';
import { MercurModules, SellerStatus } from '@mercurjs/types';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';
import type { HouseSellerService } from '../modules/packs/card-product';
import { HANDLE_RE, deriveHandle } from '../utils/profile-handle';
import { VIP_LEVELS } from './vip-levels.data';

const updateStoreCurrencies = createWorkflow(
  'update-store-currencies',
  (input: {
    supported_currencies: { currency_code: string; is_default?: boolean }[];
    store_id: string;
  }) => {
    const normalizedInput = transform({ input }, (data) => {
      return {
        selector: { id: data.input.store_id },
        update: {
          supported_currencies: data.input.supported_currencies.map(
            (currency) => {
              return {
                currency_code: currency.currency_code,
                is_default: currency.is_default ?? false,
              };
            },
          ),
        },
      };
    });

    const stores = updateStoresStep(normalizedInput);

    return new WorkflowResponse(stores);
  },
);

// ---------------------------------------------------------------------------
// Pokénic card catalog — the single source of truth for the marketplace.
//
// Seeded as products owned by a "house" seller because Mercur's store API only
// surfaces a product when it is linked to a seller whose status is "open"
// (see @mercurjs/core store/products `applyVisibleSellerIdsFilter`). The
// storefront reads these back through the Store API; `handle` doubles as the
// `/card/<slug>` route id, and `metadata` carries the card-specific facts
// (fmv/points/grade/grader/set/rarity/year) that are not first-class Medusa
// product fields. Images are local assets under the storefront's
// public/cdn/cards/ and are stored as site-relative URLs.
// ---------------------------------------------------------------------------
const HOUSE_SELLER = {
  name: 'House',
  handle: 'house',
  email: 'house@polycards.local',
} as const;

// Medusa's default demo apparel — purged by the seed for a clean catalog.
const DEMO_APPAREL_HANDLES = ['t-shirt', 'sweatshirt', 'sweatpants', 'shorts'];

// ---------------------------------------------------------------------------
// Gacha pack catalog — the Polycards tier ladder (2026-07 cutover; the old
// 8-pack seeded catalog + seeded cards/odds/demo pulls were removed for good —
// see scripts/replace-catalog-polycards.ts for the live-DB wipe half). Packs
// seed as DRAFTS with EMPTY prize pools: cards are operator-registered in
// admin, assigned to packs, then the pack is activated (an active empty pack
// would fail every spin). `slug` = the /slots/<slug> route id; asset paths
// live in the storefront's public/images/polycards/. Prices are whole-ringgit
// MYR decimals (Medusa stores prices as-is, never cents).
// ---------------------------------------------------------------------------
type PackSeed = {
  slug: string;
  title: string;
  price: number;
  image: string;
  display_image: string;
  category: string;
  rank: number;
  boost: boolean;
  buyback_percent: number;
  in_stock: boolean;
  status: 'draft';
};

const PACK_SEED: PackSeed[] = [
  { slug: 'bronze-pack', title: 'Bronze Pack', price: 50, rank: 0 },
  { slug: 'silver-pack', title: 'Silver Pack', price: 250, rank: 1 },
  { slug: 'gold-pack', title: 'Gold Pack', price: 1000, rank: 2 },
  { slug: 'platinum-pack', title: 'Platinum Pack', price: 2500, rank: 3 },
  { slug: 'diamond-pack', title: 'Diamond Pack', price: 5000, rank: 4 },
].map((p) => ({
  ...p,
  category: 'pokemon',
  image: `/images/polycards/${p.slug}.webp`,
  // The wide per-tier "factory" hero scene shown only on the pack page stage.
  display_image: `/images/polycards/${p.slug.replace('-pack', '')}-factory.webp`,
  boost: false,
  buyback_percent: 90,
  in_stock: true,
  status: 'draft' as const,
}));

const PACK_SLUGS = PACK_SEED.map((p) => p.slug);
// slug is the storefront route id AND this seed's idempotency key, so a
// duplicate would silently drop a pack — fail fast instead.
if (new Set(PACK_SLUGS).size !== PACK_SLUGS.length) {
  throw new Error('PACK_SEED contains duplicate slugs');
}

export default async function seedDemoData({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT);
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL);
  const storeModuleService = container.resolve(Modules.STORE);

  const countries = ['my'];

  logger.info('Seeding store data...');
  const [store] = await storeModuleService.listStores();
  let defaultSalesChannel = await salesChannelModuleService.listSalesChannels({
    name: 'Default Sales Channel',
  });

  if (!defaultSalesChannel.length) {
    // create the default sales channel
    const { result: salesChannelResult } = await createSalesChannelsWorkflow(
      container,
    ).run({
      input: {
        salesChannelsData: [
          {
            name: 'Default Sales Channel',
          },
        ],
      },
    });
    defaultSalesChannel = salesChannelResult;
  }

  await updateStoreCurrencies(container).run({
    input: {
      store_id: store.id,
      supported_currencies: [
        {
          currency_code: 'myr',
          is_default: true,
        },
      ],
    },
  });

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        name: 'Polycards',
        default_sales_channel_id: defaultSalesChannel[0].id,
      },
    },
  });
  logger.info('Seeding region data...');
  const regionModuleService = container.resolve(Modules.REGION);

  // Check if any of the countries are already assigned to a region
  const existingRegions = await regionModuleService.listRegions(
    {},
    {
      relations: ['countries'],
    },
  );

  const assignedCountries = new Set<string>();
  for (const r of existingRegions) {
    for (const c of r.countries || []) {
      assignedCountries.add(c.iso_2);
    }
  }

  // Single MYR region (Malaysia). The storefront queries `/store/products` with
  // this region's id to resolve `calculated_price` in MYR (card variants carry
  // MYR prices). Guarded by currency so re-runs are no-ops.
  let region = existingRegions.find((r) => r.currency_code === 'myr');
  if (!region) {
    // Only claim 'my' if no existing region already has it (countries are unique
    // to one region); a region with no country still resolves its currency.
    const myCountries = assignedCountries.has('my') ? [] : ['my'];
    const { result: regionResult } = await createRegionsWorkflow(container).run(
      {
        input: {
          regions: [
            {
              name: 'Malaysia',
              currency_code: 'myr',
              countries: myCountries,
              payment_providers: ['pp_system_default'],
            },
          ],
        },
      },
    );
    region = regionResult[0];
    logger.info(`Created Malaysia (MYR) region (${region.id}).`);
  } else {
    logger.info('Malaysia (MYR) region already exists, skipping.');
  }
  logger.info('Finished seeding regions.');

  logger.info('Seeding tax regions...');
  const taxModuleService = container.resolve(Modules.TAX);
  const existingTaxRegions = await taxModuleService.listTaxRegions();
  const existingCountryCodes = new Set(
    existingTaxRegions.map((tr) => tr.country_code),
  );
  const countriesToCreate = countries.filter(
    (c) => !existingCountryCodes.has(c),
  );

  if (countriesToCreate.length > 0) {
    await createTaxRegionsWorkflow(container).run({
      input: countriesToCreate.map((country_code) => ({
        country_code,
        provider_id: 'tp_system',
      })),
    });
  } else {
    logger.info('Tax regions already exist, skipping.');
  }
  logger.info('Finished seeding tax regions.');

  logger.info('Seeding stock location data...');
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
  const existingStockLocations = await stockLocationModule.listStockLocations({
    name: 'Malaysia Warehouse',
  });

  let stockLocation;
  if (existingStockLocations.length) {
    stockLocation = existingStockLocations[0];
    logger.info(
      "Stock location 'Malaysia Warehouse' already exists, skipping.",
    );
  } else {
    const { result: stockLocationResult } = await createStockLocationsWorkflow(
      container,
    ).run({
      input: {
        locations: [
          {
            name: 'Malaysia Warehouse',
            address: {
              city: 'Kuala Lumpur',
              country_code: 'MY',
              address_1: '',
            },
          },
        ],
      },
    });
    stockLocation = stockLocationResult[0];
  }

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        default_location_id: stockLocation.id,
      },
    },
  });

  // Link stock location to fulfillment provider (idempotent)
  try {
    await link.create({
      [Modules.STOCK_LOCATION]: {
        stock_location_id: stockLocation.id,
      },
      [Modules.FULFILLMENT]: {
        fulfillment_provider_id: 'manual_manual',
      },
    });
  } catch (error: unknown) {
    // Ignore if link already exists
    if (!(error instanceof Error && error.message.includes('already exists'))) {
      throw error;
    }
    logger.info(
      'Stock location already linked to fulfillment provider, skipping.',
    );
  }

  logger.info('Seeding fulfillment data...');
  const shippingProfiles = await fulfillmentModuleService.listShippingProfiles({
    type: 'default',
  });
  let shippingProfile = shippingProfiles.length ? shippingProfiles[0] : null;

  if (!shippingProfile) {
    const { result: shippingProfileResult } =
      await createShippingProfilesWorkflow(container).run({
        input: {
          data: [
            {
              name: 'Default Shipping Profile',
              type: 'default',
            },
          ],
        },
      });
    shippingProfile = shippingProfileResult[0];
  }

  const existingFulfillmentSets =
    await fulfillmentModuleService.listFulfillmentSets({
      name: 'Malaysia Warehouse delivery',
    });

  let fulfillmentSet;
  if (existingFulfillmentSets.length) {
    fulfillmentSet = existingFulfillmentSets[0];
    logger.info(
      "Fulfillment set 'Malaysia Warehouse delivery' already exists, skipping.",
    );
  } else {
    fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
      name: 'Malaysia Warehouse delivery',
      type: 'shipping',
      service_zones: [
        {
          name: 'Malaysia',
          geo_zones: [
            {
              country_code: 'my',
              type: 'country',
            },
          ],
        },
      ],
    });

    try {
      await link.create({
        [Modules.STOCK_LOCATION]: {
          stock_location_id: stockLocation.id,
        },
        [Modules.FULFILLMENT]: {
          fulfillment_set_id: fulfillmentSet.id,
        },
      });
    } catch (error: unknown) {
      if (
        !(error instanceof Error && error.message.includes('already exists'))
      ) {
        throw error;
      }
    }

    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: 'Standard Shipping',
          price_type: 'flat',
          provider_id: 'manual_manual',
          service_zone_id: fulfillmentSet.service_zones[0].id,
          shipping_profile_id: shippingProfile.id,
          type: {
            label: 'Standard',
            description: 'Ship in 2-3 days.',
            code: 'standard',
          },
          prices: [
            {
              region_id: region.id,
              amount: 10,
            },
          ],
          rules: [
            {
              attribute: 'enabled_in_store',
              value: 'true',
              operator: 'eq',
            },
            {
              attribute: 'is_return',
              value: 'false',
              operator: 'eq',
            },
          ],
        },
        {
          name: 'Express Shipping',
          price_type: 'flat',
          provider_id: 'manual_manual',
          service_zone_id: fulfillmentSet.service_zones[0].id,
          shipping_profile_id: shippingProfile.id,
          type: {
            label: 'Express',
            description: 'Ship in 24 hours.',
            code: 'express',
          },
          prices: [
            {
              region_id: region.id,
              amount: 10,
            },
          ],
          rules: [
            {
              attribute: 'enabled_in_store',
              value: 'true',
              operator: 'eq',
            },
            {
              attribute: 'is_return',
              value: 'false',
              operator: 'eq',
            },
          ],
        },
      ],
    });
  }
  logger.info('Finished seeding fulfillment data.');

  // Link sales channel to stock location (idempotent - workflow handles duplicates)
  try {
    await linkSalesChannelsToStockLocationWorkflow(container).run({
      input: {
        id: stockLocation.id,
        add: [defaultSalesChannel[0].id],
      },
    });
  } catch (error: unknown) {
    // Ignore if link already exists
    if (!(error instanceof Error && error.message.includes('already'))) {
      throw error;
    }
    logger.info('Sales channel already linked to stock location, skipping.');
  }
  logger.info('Finished seeding stock location data.');

  logger.info('Seeding publishable API key data...');
  let publishableApiKey;
  const { data } = await query.graph({
    entity: 'api_key',
    fields: ['id'],
    filters: {
      type: 'publishable',
    },
  });

  publishableApiKey = data?.[0];

  if (!publishableApiKey) {
    const {
      result: [publishableApiKeyResult],
    } = await createApiKeysWorkflow(container).run({
      input: {
        api_keys: [
          {
            title: 'Webshop',
            type: 'publishable',
            created_by: '',
          },
        ],
      },
    });

    publishableApiKey = publishableApiKeyResult;
  }

  // Link sales channel to API key (idempotent)
  try {
    await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: {
        id: publishableApiKey.id,
        add: [defaultSalesChannel[0].id],
      },
    });
  } catch (error: unknown) {
    // Ignore if link already exists
    if (!(error instanceof Error && error.message.includes('already'))) {
      throw error;
    }
    logger.info('Sales channel already linked to API key, skipping.');
  }
  logger.info('Finished seeding publishable API key data.');

  logger.info('Seeding marketplace catalog...');

  const productModule = container.resolve(Modules.PRODUCT);

  // House seller — Mercur's store/products filter only surfaces products linked
  // to a seller whose status is "open", so the catalog needs one owner. Guarded
  // by handle (name/email/handle are unique) so re-runs are idempotent.
  const sellerService = container.resolve<HouseSellerService>(
    MercurModules.SELLER,
  );
  const existingSellers = await sellerService.listSellers({
    handle: HOUSE_SELLER.handle,
  });

  let houseSeller = existingSellers[0];
  if (!houseSeller) {
    const [created] = await sellerService.createSellers([
      {
        ...HOUSE_SELLER,
        currency_code: 'myr',
        status: SellerStatus.OPEN,
        metadata: { house: true },
      },
    ]);
    // createSellers returns a SellerDTO (no member_invites relation); widen it
    // to the listSellers element type so the assignment type-checks (only .id is
    // used below — safe at runtime).
    houseSeller = created as (typeof existingSellers)[number];
    logger.info(`Created house seller (${houseSeller.id}).`);
  } else {
    logger.info('House seller already exists, skipping.');
  }

  // Purge the 4 default Medusa demo apparel products for a clean card catalog
  // (best-effort: they are invisible anyway with no seller link).
  const apparelProducts = await productModule.listProducts({
    handle: DEMO_APPAREL_HANDLES,
  });
  if (apparelProducts.length) {
    try {
      await deleteProductsWorkflow(container).run({
        input: { ids: apparelProducts.map((p) => p.id) },
      });
      logger.info(`Purged ${apparelProducts.length} demo apparel product(s).`);
    } catch (error: unknown) {
      logger.warn(
        `Could not purge demo apparel products: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  logger.info('Finished seeding marketplace catalog.');

  logger.info('Seeding inventory levels.');

  const { data: inventoryItems } = await query.graph({
    entity: 'inventory_item',
    fields: ['id'],
  });

  const inventoryModule = container.resolve(Modules.INVENTORY);
  const existingLevels = await inventoryModule.listInventoryLevels({
    location_id: stockLocation.id,
  });
  const existingItemIds = new Set(
    existingLevels.map((l) => l.inventory_item_id),
  );

  const inventoryLevels: CreateInventoryLevelInput[] = [];
  for (const inventoryItem of inventoryItems) {
    if (!existingItemIds.has(inventoryItem.id)) {
      const inventoryLevel = {
        location_id: stockLocation.id,
        stocked_quantity: 1000000,
        inventory_item_id: inventoryItem.id,
      };
      inventoryLevels.push(inventoryLevel);
    }
  }

  if (inventoryLevels.length > 0) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: inventoryLevels,
      },
    });
  } else {
    logger.info('Inventory levels already exist, skipping.');
  }

  logger.info('Finished seeding inventory levels data.');

  // Gacha packs (Phase 4) — guarded by slug so re-runs are no-ops. Independent
  // of products/inventory: the Pack model is catalog-only this phase (the
  // pack->product checkout link + odds land in Phase 5).
  logger.info('Seeding gacha packs...');
  const packsModuleService: PacksModuleService =
    container.resolve(PACKS_MODULE);
  const existingPacks = await packsModuleService.listPacks(
    { slug: PACK_SLUGS },
    { select: ['slug'], take: PACK_SLUGS.length },
  );
  const existingPackSlugs = new Set(existingPacks.map((p) => p.slug));
  const packsToCreate = PACK_SEED.filter((p) => !existingPackSlugs.has(p.slug));

  if (packsToCreate.length === 0) {
    logger.info('Gacha packs already exist, skipping.');
  } else {
    // Seeded as DRAFT (empty prize pool — see PACK_SEED note): the operator
    // registers cards, assigns them to the pack, then activates it in admin.
    await packsModuleService.createPacks(packsToCreate);
    logger.info(
      `Seeded ${packsToCreate.length} DRAFT gacha pack(s) — assign cards, then activate.`,
    );
  }
  logger.info('Finished seeding gacha packs.');

  // VIP levels — idempotent upsert-if-absent by `level` (mirrors the packs seed).
  logger.info('Seeding VIP levels...');
  const existingVipLevels = await packsModuleService.listVipLevels(
    { level: VIP_LEVELS.map((r) => r.level) },
    { select: ['level'], take: VIP_LEVELS.length },
  );
  const haveLevels = new Set(existingVipLevels.map((r) => r.level));
  const vipLevelsToCreate = VIP_LEVELS.filter((r) => !haveLevels.has(r.level));
  if (vipLevelsToCreate.length === 0) {
    logger.info('VIP levels already exist, skipping.');
  } else {
    await packsModuleService.createVipLevels(
      vipLevelsToCreate.map((r) => ({ ...r })),
    );
    logger.info(`Seeded ${vipLevelsToCreate.length} VIP levels.`);
  }

  // Everything below this point is DEMO/DEV convenience: a roster of display-only
  // demo collectors (public profiles resolve to someone on a fresh clone) and one
  // loginable test customer. A PRODUCTION seed wants neither — set SEED_DEMO=false
  // so the launch starts with a genuinely empty customer table.
  // NOTE: this block seeds NO Pull rows (it once did; that was removed), so the
  // public leaderboard and the Weekly Challenge pool start empty either way.
  if (process.env.SEED_DEMO === 'false') {
    logger.info(
      'SEED_DEMO=false — skipping demo collectors + test login (production seed).',
    );
    return;
  }

  logger.info('Seeding demo collectors...');
  const customerModuleService = container.resolve(Modules.CUSTOMER);

  const DEMO_COLLECTORS = [
    { first_name: 'Kenji', email: 'demo-collector-1@polycards.local' },
    { first_name: 'Mira', email: 'demo-collector-2@polycards.local' },
    { first_name: 'Diego', email: 'demo-collector-3@polycards.local' },
    { first_name: 'Anaya', email: 'demo-collector-4@polycards.local' },
    { first_name: 'Leo', email: 'demo-collector-5@polycards.local' },
    { first_name: 'Sora', email: 'demo-collector-6@polycards.local' },
    { first_name: 'Bianca', email: 'demo-collector-7@polycards.local' },
    { first_name: 'Ravi', email: 'demo-collector-8@polycards.local' },
  ];
  const demoEmails = DEMO_COLLECTORS.map((c) => c.email);
  const existingDemoCustomers = await customerModuleService.listCustomers(
    { email: demoEmails },
    { take: demoEmails.length },
  );
  const existingDemoEmails = new Set(existingDemoCustomers.map((c) => c.email));
  const demoToCreate = DEMO_COLLECTORS.filter(
    (c) => !existingDemoEmails.has(c.email),
  );
  const createdDemoCustomers = demoToCreate.length
    ? await customerModuleService.createCustomers(demoToCreate)
    : [];

  // Order by the roster (createCustomers needn't preserve input order) so the
  // descending activity assignment below is stable.
  const demoByEmail = new Map(
    [...existingDemoCustomers, ...createdDemoCustomers].map((c) => [
      c.email,
      c,
    ]),
  );
  const orderedDemo = DEMO_COLLECTORS.map((d) =>
    demoByEmail.get(d.email),
  ).filter((c): c is NonNullable<typeof c> => !!c);

  // Public profile handles (Task B): every demo collector gets a stable
  // metadata.handle so /store/profiles/:handle resolves them. Idempotent —
  // derivation is deterministic and existing handles are left untouched.
  for (const c of orderedDemo) {
    const metadata = (c.metadata ?? {}) as Record<string, unknown>;
    if (
      typeof metadata.handle === 'string' &&
      HANDLE_RE.test(metadata.handle)
    ) {
      continue;
    }
    await customerModuleService.updateCustomers(c.id, {
      metadata: { ...metadata, handle: deriveHandle(c.first_name, c.id) },
    });
  }

  logger.info('Finished seeding demo gacha activity.');

  // ---------------------------------------------------------------------------
  // Convenience test login — ONE loginable customer (emailpass) so every
  // environment shares the same dev credentials (no need to remember per-env
  // logins). Unlike the demo collectors above (display-only, no password), this
  // one registers an emailpass auth identity linked to the customer, so it can
  // actually sign in on the storefront. Idempotent: skips if the customer email
  // already exists. Env-overridable; defaults to the shared dev login.
  // ---------------------------------------------------------------------------
  logger.info('Seeding test customer login...');
  const TEST_EMAIL = process.env.TEST_CUSTOMER_EMAIL || 'test@polycards.app';
  const TEST_PASSWORD = process.env.TEST_CUSTOMER_PASSWORD || 'PolycardsTest123!';
  const authModuleService = container.resolve(Modules.AUTH);

  const [existingTestCustomer] = await customerModuleService.listCustomers({
    email: TEST_EMAIL,
  });
  if (existingTestCustomer) {
    logger.info(`Test customer ${TEST_EMAIL} already exists, skipping.`);
  } else {
    const { authIdentity, error } = await authModuleService.register(
      'emailpass',
      { body: { email: TEST_EMAIL, password: TEST_PASSWORD } },
    );
    if (error || !authIdentity) {
      logger.warn(`Test customer auth register failed: ${error}`);
    } else {
      const [testCustomer] = await customerModuleService.createCustomers([
        { email: TEST_EMAIL, first_name: 'tester' },
      ]);
      // Public profile handle (Task B) so /store/profiles/:handle resolves.
      await customerModuleService.updateCustomers(testCustomer.id, {
        metadata: { handle: deriveHandle('tester', testCustomer.id) },
      });
      // Link the auth identity to the customer (actor_type customer) — mirrors
      // create-admin.ts's user_id linkage. Without this the login resolves no
      // actor and /store/customers/me returns nothing.
      await authModuleService.updateAuthIdentities({
        id: authIdentity.id,
        app_metadata: { customer_id: testCustomer.id },
      });
      logger.info(`Seeded test customer ${TEST_EMAIL} (${testCustomer.id}).`);
    }
  }
  logger.info('Finished seeding test customer login.');
}
