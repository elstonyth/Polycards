// Card management workflow through the admin dashboard UI: register an inventory
// product as a gacha card, adjust its facts (FMV + marketplace toggle), and prove
// the adjustment is captured on the storefront. The storefront's pack-detail
// "Top Hits" is driven by the card's market_value via GET /store/packs/{slug} —
// so a card FMV edit must surface there.
//
// Requires one eligible (un-registered) inventory product. Mint it once with:
//   cd backend/packages/api && npx medusa exec ./src/scripts/create-test-product.ts
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
    `No eligible product '${CARD_HANDLE}' — run create-test-product.ts first.`,
  );

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

    await test.step('adjust FMV + list it on the marketplace (UI)', async () => {
      await editCard(page, PRODUCT_TITLE, {
        marketValue: BIG_FMV,
        forSale: true,
      });
      const card = (await listCards(admin)).cards.find(
        (c) => c.handle === CARD_HANDLE,
      );
      expect(card?.market_value).toBe(BIG_FMV);
      expect(card?.for_sale).toBe(true);
    });

    await test.step('put the card in an active pack so it surfaces publicly', async () => {
      await setMembers(admin, POOL_PACK, [...originalPool, CARD_HANDLE]);
    });

    await test.step('storefront pack data reflects the new FMV', async () => {
      // The exact endpoint /claw/[slug] consumes for its Top Hits.
      const detail = await api<{
        odds: Array<{ handle: string; market_value: number }>;
      }>(`/store/packs/${POOL_PACK}`);
      const entry = detail.odds.find((e) => e.handle === CARD_HANDLE);
      expect(entry?.market_value).toBe(BIG_FMV);
    });

    await test.step('the card + its new FMV render in storefront Top Hits', async () => {
      await page.goto(`${BASE}/claw/${POOL_PACK}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByText(/top hits/i).first()).toBeVisible();
      // The card renders as an <img alt={name}> with its FMV beneath it.
      await expect(page.getByAltText(PRODUCT_TITLE).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('RM 99,999.00').first()).toBeVisible();
    });
  } finally {
    // Restore the pack pool and remove the throwaway card (keeps the product,
    // which becomes eligible again for the next run).
    await setMembers(admin, POOL_PACK, originalPool);
    await deleteCardIfExists(admin, CARD_HANDLE);
  }
});

test('deleting the card frees the product to be eligible again', async () => {
  // After the lifecycle test's cleanup, the product is un-registered once more.
  const elig = await eligibleProducts(admin);
  expect(elig.products.some((p) => p.handle === CARD_HANDLE)).toBe(true);
});
