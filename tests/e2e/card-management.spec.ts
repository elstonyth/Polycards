// Card management workflow through the admin dashboard UI: register an inventory
// product as a gacha card, adjust its facts (FMV + marketplace toggle), and prove
// the adjustment is captured on the storefront. The storefront's pack-detail
// "Top Hits" is driven by the card's market_value via GET /store/packs/{slug} —
// so a card FMV edit must surface there.
//
// Requires one eligible (un-registered) inventory product with handle
// 'pw-test-card'. The nightly's seed:e2e (seed-e2e-fixtures.ts) mints it; run it
// locally the same way:
//   cd backend/packages/api && corepack yarn seed:e2e
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import {
  adminToken,
  api,
  eligibleProducts,
  listCards,
  deleteCardIfExists,
  getOdds,
  setMembers,
} from './helpers/api';
import {
  ensureAdmin,
  registerCardFromInventory,
  editCard,
} from './helpers/admin';

const PRODUCT_TITLE = 'PW Test Eligible Card';
const CARD_HANDLE = 'pw-test-card';
const POOL_PACK = 'pokemon-rookie';
const BIG_FMV = 99_999;

let admin: string;
// The eligibility re-check below only means something after the lifecycle test
// actually ran (it verifies that test's cleanup). The product comes from
// seed:e2e; if it's absent both tests skip — in CI that skip means the seed
// didn't run and is a failure signal, not the expected state.
let lifecycleRan = false;

test.beforeAll(async () => {
  admin = await adminToken();
  // Clean slate: deleting the card (if a prior run left it) makes the product
  // eligible to register again.
  await deleteCardIfExists(admin, CARD_HANDLE);
});

test('card lifecycle: register from inventory → adjust FMV → reflects on storefront', async ({
  page,
}) => {
  // Guard: skip clearly if the eligible product was never minted.
  const elig = await eligibleProducts(admin);
  test.skip(
    !elig.products.some((p) => p.handle === CARD_HANDLE),
    `No eligible product '${CARD_HANDLE}' — run seed:e2e (seed-e2e-fixtures.ts) first.`,
  );
  lifecycleRan = true;

  const originalPool = (await getOdds(admin, POOL_PACK)).odds.map(
    (o) => o.card_id,
  );

  try {
    await ensureAdmin(page);

    await test.step('register the product as a gacha card (UI)', async () => {
      await registerCardFromInventory(page, PRODUCT_TITLE, 12.5);
      await expect(page.getByText(PRODUCT_TITLE).first()).toBeVisible();
      const { cards } = await listCards(admin);
      expect(cards.map((c) => c.handle)).toContain(CARD_HANDLE);
    });

    // The RM price the storefront should display for this card (FMV × the
    // card's own multiplier) — captured after the FMV edit below.
    let displayMyr = 0;

    await test.step('adjust FMV + list it on the marketplace (UI)', async () => {
      await editCard(page, PRODUCT_TITLE, {
        marketValue: BIG_FMV,
        forSale: true,
      });
      const card = (await listCards(admin)).cards.find(
        (c) => c.handle === CARD_HANDLE,
      );
      // The admin FMV field is MYR since the FX localization: the entered RM
      // figure is stored as USD (market_value = RM ÷ fx). Assert the RM
      // round-trip via the server's own price breakdown, not the raw USD.
      expect(card?.priceBreakdown?.marketMyr).toBeCloseTo(BIG_FMV, 0);
      expect(card?.for_sale).toBe(true);
      displayMyr = card?.priceBreakdown?.displayPrice ?? 0;
      expect(displayMyr).toBeGreaterThan(0);
    });

    await test.step('put the card in an active pack so it surfaces publicly', async () => {
      await setMembers(admin, POOL_PACK, [...originalPool, CARD_HANDLE]);
    });

    await test.step('storefront pack data reflects the new FMV', async () => {
      // The exact endpoint the /slots/[slug] page consumes for its card grid.
      const detail = await api<{
        odds: Array<{ handle: string; marketPriceMyr: number }>;
      }>(`/store/packs/${POOL_PACK}`);
      const entry = detail.odds.find((e) => e.handle === CARD_HANDLE);
      // marketPriceMyr = USD FMV × fx × multiplier — must match the admin's
      // own displayPrice for the same card.
      expect(entry?.marketPriceMyr).toBeCloseTo(displayMyr, 1);
    });

    await test.step('the card + its new FMV render on the storefront pack page', async () => {
      await page.goto(`${BASE}/slots/${POOL_PACK}`, {
        waitUntil: 'domcontentloaded',
      });
      // The full pool grid always renders every card (Top Hits shows only when
      // the admin curated some, so don't gate on that heading).
      await expect(page.getByText(/cards in this pack/i).first()).toBeVisible();
      // A card tile is ONE button named after the card; its slab <img> alt is
      // empty by design.
      await expect(
        page
          .getByRole('button', { name: `View details for ${PRODUCT_TITLE}` })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      const rmDisplay = `RM ${displayMyr.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      await expect(page.getByText(rmDisplay).first()).toBeVisible();
    });
  } finally {
    // Restore the pack pool and remove the throwaway card (keeps the product,
    // which becomes eligible again for the next run).
    await setMembers(admin, POOL_PACK, originalPool);
    await deleteCardIfExists(admin, CARD_HANDLE);
  }
});

test('deleting the card frees the product to be eligible again', async () => {
  test.skip(!lifecycleRan, 'lifecycle test skipped — no cleanup to verify');
  // After the lifecycle test's cleanup, the product is un-registered once more.
  const elig = await eligibleProducts(admin);
  expect(elig.products.some((p) => p.handle === CARD_HANDLE)).toBe(true);
});
