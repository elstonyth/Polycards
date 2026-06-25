/**
 * seed-reward-economy-demo.ts
 *
 * Demo seed for the VIP reward economy (Phase G2).
 *
 * What this seeds:
 *   - A tier-'c' reward_box Pack  (slug: reward-box-c, status: active,
 *     pool_enabled: true, draws_per_day: 3, price: 0)
 *   - 3 reward PackOdds entries:
 *       1. kind:'product'  product_handle:'celebi'  weight:10
 *       2. kind:'credit'   credit_amount:5           weight:20
 *       3. kind:'nothing'                            weight:70
 *   - Ensures the demo test customer's vip_member_state.highest_level_ever
 *     maps to box_tier 'c' (level 20 is the first tier-c level).
 *     Uses upsertVipMemberState so the customer can reach tier-c without
 *     spending any real money.
 *
 * HOW TO RUN THE DEMO
 * -------------------
 *   1. Start the backend:
 *        cd backend/packages/api
 *        corepack yarn medusa develop
 *
 *   2. In a second terminal, run this seed:
 *        corepack yarn medusa exec ./src/scripts/seed-reward-economy-demo.ts
 *
 *   3. Enable the reward gate (required for draw + claim; withdraw is always on):
 *        export REWARDS_REDEMPTION_ENABLED=true
 *        # or set it in your .env and restart medusa develop
 *
 *   4. Log in as the test customer (test@pokenic.app / PokenicTest123!) on
 *      the storefront and exercise the reward routes:
 *
 *      GET  /store/rewards              → active grants + draw state + vault prizes
 *      POST /store/rewards/draw         → consume one of 3 daily draws
 *      POST /store/rewards/claim/:id    → claim a voucher or frame grant
 *      POST /store/rewards/withdraw     → ship a vaulted product prize
 *
 *   5. To reset: delete reward_draw rows for the customer and re-run this seed
 *      (it is idempotent — existing rows are not re-created).
 *
 * NOTES
 * -----
 *   - 'celebi' is a real product handle seeded by seed.ts. Run the main seed
 *     first (corepack yarn medusa exec ./src/scripts/seed.ts) so the product
 *     exists and the stock-gate in drawPrize passes.
 *   - credit_amount: 5 is stored as bigNumber decimal MYR — the draw workflow
 *     credits the customer +5 MYR via mutateCreditAtomic('reward_credit').
 *   - The tier-c upsert uses lifetimeSen: 0 + currentLevel: 20 + highestLevelEver: 20.
 *     The real VIP ladder bases promotion on external-funded spend in MYR sen;
 *     for demo purposes we set the projection directly without touching the ledger.
 *     This is safe: upsertVipMemberState only writes vip_member_state — it does not
 *     create credit_transaction rows and does not affect the money basis.
 */

import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service.js';
import { PACKS_MODULE } from '../modules/packs/index.js';

// The first VIP level whose box_tier === 'c' (per vip-levels.data.ts).
// Setting highest_level_ever to 20 guarantees tier resolution returns 'c'.
const TIER_C_LEVEL = 20;

// Slug convention used by resolveRewardBoxPack: `reward-box-<tier>`.
const REWARD_BOX_SLUG = 'reward-box-c';

// A real product handle from the seeded catalog (seed.ts CARD_PRODUCTS).
const DEMO_PRODUCT_HANDLE = 'celebi';

export default async function seedRewardEconomyDemo({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // ── 1. Reward-box Pack ──────────────────────────────────────────────────────
  logger.info('[reward-demo] Seeding tier-c reward_box Pack...');

  const existingPacks = await packs.listPacks(
    { slug: [REWARD_BOX_SLUG] },
    { select: ['slug', 'pool_enabled', 'draws_per_day'], take: 1 },
  );

  let rewardBoxSlug: string;
  if (existingPacks.length > 0) {
    logger.info(
      `[reward-demo] reward_box Pack "${REWARD_BOX_SLUG}" already exists, skipping.`,
    );
    rewardBoxSlug = existingPacks[0].slug;
  } else {
    const [created] = await packs.createPacks([
      {
        slug: REWARD_BOX_SLUG,
        title: 'Tier C Reward Box',
        category: 'reward_box',
        status: 'active',
        pool_enabled: true,
        draws_per_day: 3,
        price: 0,
        image: '',
        rank: 0,
        boost: false,
        buyback_percent: 0,
        in_stock: true,
      },
    ]);
    rewardBoxSlug = created.slug;
    logger.info(`[reward-demo] Created reward_box Pack "${rewardBoxSlug}".`);
  }

  // ── 2. Reward PackOdds entries ──────────────────────────────────────────────
  logger.info('[reward-demo] Seeding reward PackOdds entries...');

  const existingOdds = await packs.listPackOdds(
    { pack_id: [rewardBoxSlug] },
    { select: ['id', 'kind'], take: 10 },
  );

  if (existingOdds.length > 0) {
    logger.info(
      `[reward-demo] PackOdds for "${rewardBoxSlug}" already exist (${existingOdds.length} rows), skipping.`,
    );
  } else {
    await packs.createPackOdds([
      {
        pack_id: rewardBoxSlug,
        kind: 'product',
        product_handle: DEMO_PRODUCT_HANDLE,
        credit_amount: null,
        card_id: null,
        rarity: null,
        weight: 10,
      },
      {
        pack_id: rewardBoxSlug,
        kind: 'credit',
        credit_amount: 5,
        product_handle: null,
        card_id: null,
        rarity: null,
        weight: 20,
      },
      {
        pack_id: rewardBoxSlug,
        kind: 'nothing',
        product_handle: null,
        credit_amount: null,
        card_id: null,
        rarity: null,
        weight: 70,
      },
    ]);
    logger.info('[reward-demo] Seeded 3 reward PackOdds entries.');
  }

  // ── 3. Bump test customer to tier-c VIP state ───────────────────────────────
  logger.info('[reward-demo] Ensuring test customer VIP state = tier c...');

  const customerModule = container.resolve(Modules.CUSTOMER);

  const TEST_EMAIL =
    process.env.TEST_CUSTOMER_EMAIL ?? 'test@pokenic.app';

  const [testCustomer] = await customerModule.listCustomers(
    { email: TEST_EMAIL },
    { take: 1 },
  );

  if (!testCustomer) {
    logger.warn(
      `[reward-demo] Test customer "${TEST_EMAIL}" not found — run the main seed.ts first.`,
    );
  } else {
    // Read current state to avoid regressing highest_level_ever if it's already higher.
    const [existingState] = await packs.listVipMemberStates(
      { customer_id: testCustomer.id },
      { select: ['highest_level_ever', 'current_level'], take: 1 },
    );

    const currentHighest = existingState
      ? Number(existingState.highest_level_ever)
      : 0;

    if (currentHighest >= TIER_C_LEVEL) {
      logger.info(
        `[reward-demo] Customer already at level ${currentHighest} (>= ${TIER_C_LEVEL}), skipping upsert.`,
      );
    } else {
      await packs.upsertVipMemberState(
        {
          customerId: testCustomer.id,
          lifetimeSen: 0, // ponytail: no real ledger spend needed for demo
          highestLevelEver: TIER_C_LEVEL,
          currentLevel: TIER_C_LEVEL,
        },
      );
      logger.info(
        `[reward-demo] Upserted VIP state for "${TEST_EMAIL}" → highest_level_ever = ${TIER_C_LEVEL} (box_tier 'c').`,
      );
    }
  }

  logger.info('[reward-demo] Done. Set REWARDS_REDEMPTION_ENABLED=true to exercise draw/claim routes.');
}
