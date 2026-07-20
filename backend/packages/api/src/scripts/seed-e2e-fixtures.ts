import { ExecArgs } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { createProductsWorkflow } from '@medusajs/medusa/core-flows';
import { RARITY_WEIGHT, type OddsRarity } from '@acme/odds-math';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  buildCardProductInput,
  resolveCardProductContext,
} from '../modules/packs/card-product';

// seed-e2e-fixtures — E2E-ONLY fixture. The prod catalog seed (seed.ts, run by
// deploy:init) ships packs as EMPTY DRAFTS by design (operators register cards
// in admin), so a fresh CI DB has NO openable pack — the whole nightly E2E suite
// then dies at auth.setup's `seed packs present` preflight and 19 specs never
// run. This script recreates the two fully-populated, ACTIVE packs the specs
// hardcode (pokemon-rookie / pokemon-elite) with just the rows a pack open
// actually reads: an active Pack, its Card rows, and weighted PackOdds. No
// product/inventory/slab-bake — the roll (workflows/steps/roll-pack.ts) needs
// none of that, and skipping it also dodges the localhost-SSRF bake trap in CI.
//
// NEVER wire this into deploy:init — it must not touch the prod catalog. It runs
// only from the e2e workflow (deploy:seed-e2e) and locally when driving the suite.
//
// Idempotent: guarded by pack slug, card handle, and (pack_id, card_id) so a
// re-run is a no-op. Run from backend/packages/api:
//   corepack yarn medusa exec ./src/scripts/seed-e2e-fixtures.ts

type CardSeed = {
  handle: string;
  name: string;
  rarity: OddsRarity; // the card's tier IN THESE PACKS (drives PackOdds.weight)
  market_value: number; // raw USD FMV decimal (the system's only USD)
};

// A small mixed-rarity pool, shared by both packs (odds are per-pack rows, so
// sharing cards keeps the two packs' draws fully independent). Distinct names —
// odds-reflection.spec's forceCardTo100ViaUI selects a card by name. Images
// point at real seeded assets (public/cdn/cards/h-0NN.webp) so nothing 404s.
const CARDS: CardSeed[] = [
  {
    handle: 'pw-pikachu',
    name: 'PW Pikachu',
    rarity: 'Common',
    market_value: 5,
  },
  {
    handle: 'pw-bulbasaur',
    name: 'PW Bulbasaur',
    rarity: 'Common',
    market_value: 8,
  },
  {
    handle: 'pw-jolteon',
    name: 'PW Jolteon',
    rarity: 'Uncommon',
    market_value: 25,
  },
  { handle: 'pw-gengar', name: 'PW Gengar', rarity: 'Rare', market_value: 120 },
  {
    handle: 'pw-charizard',
    name: 'PW Charizard',
    rarity: 'Rare',
    market_value: 350,
  },
  {
    handle: 'pw-mewtwo',
    name: 'PW Mewtwo',
    rarity: 'Mythical',
    market_value: 900,
  },
];

const cardImage = (n: number): string =>
  `/cdn/cards/h-${String(n).padStart(3, '0')}.webp`;

type PackSeed = { slug: string; title: string; price: number; rank: number };

// Net-new packs — the base seed owns bronze/silver/gold/platinum/diamond, so
// these slugs never collide. Prices match odds-reflection.spec's funding math
// (rookie RM25, elite RM50: 3 opens of each = RM225, under the RM400 it funds).
const PACKS: PackSeed[] = [
  {
    slug: 'pokemon-rookie',
    title: 'Pokémon Rookie (E2E)',
    price: 25,
    rank: 90,
  },
  { slug: 'pokemon-elite', title: 'Pokémon Elite (E2E)', price: 50, rank: 91 },
];

export default async function seedE2eFixtures({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const packSlugs = PACKS.map((p) => p.slug);
  const cardHandles = CARDS.map((c) => c.handle);

  // --- Packs (active) ------------------------------------------------------
  const existingPacks = await packs.listPacks(
    { slug: packSlugs },
    { select: ['slug'], take: packSlugs.length },
  );
  const havePack = new Set(existingPacks.map((p) => p.slug));
  const packsToCreate = PACKS.filter((p) => !havePack.has(p.slug)).map((p) => ({
    slug: p.slug,
    title: p.title,
    category: 'pokemon', // must be non-'reward_box' to be openable
    price: p.price,
    image: `/images/polycards/bronze-pack.webp`, // reuse a real seeded asset
    rank: p.rank,
    status: 'active' as const,
  }));
  if (packsToCreate.length > 0) {
    await packs.createPacks(packsToCreate);
    logger.info(`[e2e] Seeded ${packsToCreate.length} active pack(s).`);
  } else {
    logger.info('[e2e] Packs already present, skipping.');
  }

  // --- Cards ---------------------------------------------------------------
  const existingCards = await packs.listCards(
    { handle: cardHandles },
    { select: ['handle'], take: cardHandles.length },
  );
  const haveCard = new Set(existingCards.map((c) => c.handle));
  const cardsToCreate = CARDS.filter((c) => !haveCard.has(c.handle)).map(
    (c, i) => ({
      handle: c.handle,
      name: c.name,
      set: 'PW E2E Set',
      grader: 'PSA',
      grade: '10',
      market_value: c.market_value,
      image: cardImage(i + 1),
      // Gacha-pool only; there is no backing Medusa product, so keep it off the
      // marketplace (for_sale defaults true, which assumes a mirrored product).
      for_sale: false,
    }),
  );
  if (cardsToCreate.length > 0) {
    await packs.createCards(cardsToCreate);
    logger.info(`[e2e] Seeded ${cardsToCreate.length} card(s).`);
  } else {
    logger.info('[e2e] Cards already present, skipping.');
  }

  // --- Odds (one weighted row per pack×card) -------------------------------
  // Pull chance = weight / Σ(weights in pack). RARITY_WEIGHT is the same table
  // the live odds engine uses, so fixture weights can't drift from the tiers.
  // Idempotency is keyed per (pack, card), not per pack: a partial failure that
  // created only some of a pack's odds rows must be backfilled on re-run, not
  // skipped because the pack already has *an* odds row.
  const existingOdds = await packs.listPackOdds(
    { pack_id: packSlugs },
    { select: ['pack_id', 'card_id'], take: packSlugs.length * CARDS.length + 1 },
  );
  const oddsKey = (packId: string, cardId: string): string =>
    `${packId}::${cardId}`;
  const haveOdds = new Set(
    existingOdds.map((o) => oddsKey(o.pack_id, o.card_id ?? '')),
  );
  const oddsToCreate = PACKS.flatMap((pack) =>
    CARDS.filter((card) => !haveOdds.has(oddsKey(pack.slug, card.handle))).map(
      (card) => ({
        pack_id: pack.slug,
        card_id: card.handle,
        rarity: card.rarity,
        weight: RARITY_WEIGHT[card.rarity],
      }),
    ),
  );
  if (oddsToCreate.length > 0) {
    await packs.createPackOdds(oddsToCreate);
    logger.info(`[e2e] Seeded ${oddsToCreate.length} pack-odds row(s).`);
  } else {
    logger.info('[e2e] Pack odds already present, skipping.');
  }

  // --- FX rate (firm) ------------------------------------------------------
  // Buyback quotes are FIRM only when a USD_MYR FxRate row exists (else
  // resolveFxRateInfo returns firm:false and the reveal shows "Keep in vault"
  // with NO sell button, and the vault bulk-sell button is disabled). The base
  // seed creates none — locally a scheduled frankfurter fetch fills it, but a
  // fresh CI DB has nothing, so every sell-path spec (reveal sell, vault
  // bulk-sell) fails. Seed one firm rate so those flows are exercisable.
  const [fx] = await packs.listFxRates({ pair: 'USD_MYR' }, { take: 1 });
  if (!fx) {
    await packs.createFxRates([
      {
        pair: 'USD_MYR',
        rate: 4.0725,
        source: 'e2e-fixture',
        manual_override: false,
        manual_rate: null,
      },
    ]);
    logger.info('[e2e] Seeded firm USD_MYR FX rate.');
  } else {
    logger.info('[e2e] FX rate already present, skipping.');
  }

  // --- Eligible inventory product (card-management.spec.ts) ----------------
  // The admin lifecycle spec (register from inventory → FMV edit → storefront
  // reflection) only runs when GET /admin/gacha/eligible-products lists an
  // un-registered product with this handle. Eligibility = "a product whose
  // handle is not yet a Card". The prod seed registers all its products, so the
  // list is empty on a fresh DB — mint ONE un-registered product here (ported
  // from the hand-run create-test-product.ts). We create only the PRODUCT, never
  // a Card, so it stays eligible; the spec's beforeAll deletes any leftover card.
  const productModule = container.resolve(Modules.PRODUCT);
  const CARD_PRODUCT_HANDLE = 'pw-test-card';
  const [existingProduct] = await productModule.listProducts(
    { handle: CARD_PRODUCT_HANDLE },
    { take: 1 },
  );
  if (existingProduct) {
    logger.info('[e2e] Eligible test product already present, skipping.');
  } else {
    const ctx = await resolveCardProductContext(container);
    const input = buildCardProductInput(
      {
        handle: CARD_PRODUCT_HANDLE,
        title: 'PW Test Eligible Card',
        image: '/cdn/cards/celebi.webp', // reuse a seeded image
        price: 12.5,
        metadata: {
          fmv: 12.5,
          points: 90,
          grade: '9',
          grader: 'PSA',
          set: 'PW Test Set',
          year: 2026,
        },
      },
      {
        shippingProfileId: ctx.shippingProfileId,
        salesChannelId: ctx.salesChannelId,
        status: ProductStatus.PUBLISHED,
        manageInventory: false, // untracked => ∞ stock, drawable when pooled
      },
    );
    await createProductsWorkflow(container).run({
      input: {
        products: [input],
        additional_data: { seller_id: ctx.sellerId },
      },
    });
    logger.info(`[e2e] Seeded eligible test product '${CARD_PRODUCT_HANDLE}'.`);
  }

  // --- Claimable voucher grant (rewards.spec.ts) ---------------------------
  // rewards.spec.ts logs in as the shared dev customer and claims a 'granted'
  // voucher on /vip. That customer IS seeded (seed.ts's SEED_DEMO path, run by
  // deploy:init BEFORE this fixture in the nightly), but NO seed path mints the
  // grant — the spec header's "already holds granted vouchers" is aspirational.
  // Mint one here so the UI claim leg is exercisable (also needs the gate open:
  // REWARDS_REDEMPTION_ENABLED, set by e2e.yml). Ladder level-2 voucher — the
  // shape a real level-up mints.
  const customerModule = container.resolve(Modules.CUSTOMER);
  const REWARD_EMAIL = process.env.TEST_CUSTOMER_EMAIL ?? 'test@polycards.app';
  const [rewardCustomer] = await customerModule.listCustomers(
    { email: REWARD_EMAIL },
    { take: 1 },
  );
  if (!rewardCustomer) {
    // Not fatal: in the nightly deploy:init seeds this customer first. A local
    // seed:e2e without seed.ts's demo path lands here — warn loudly (a silent
    // skip is exactly the dark-spec problem this fixture fixes) and move on.
    logger.warn(
      `[e2e] Reward customer '${REWARD_EMAIL}' not found — skipping voucher ` +
        'grant. Run deploy:init (seed.ts, SEED_DEMO on) first; the nightly does.',
    );
  } else {
    // Idempotent by deterministic id: covers first-run (create), a re-run before
    // the spec claims it (sees 'granted'), and a re-run after (sees 'fulfilled').
    const grantId = `vrg_e2e_${rewardCustomer.id}_voucher`;
    const [existingGrant] = await packs.listVipRewardGrants(
      { id: grantId },
      { take: 1 },
    );
    if (existingGrant) {
      logger.info('[e2e] E2E voucher grant already present, skipping.');
    } else {
      await packs.createVipRewardGrants([
        {
          id: grantId,
          customer_id: rewardCustomer.id,
          level: 2,
          kind: 'voucher',
          payload: { amount_myr: 5 },
          status: 'granted',
          source_open_id: 'seed-e2e-fixtures',
        },
      ]);
      logger.info(`[e2e] Seeded claimable voucher grant for '${REWARD_EMAIL}'.`);
    }
  }

  logger.info('[e2e] Fixture seed complete.');
}
