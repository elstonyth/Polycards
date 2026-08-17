// Card management workflow through the admin dashboard UI: register an inventory
// product as a gacha card, adjust its facts (FMV + marketplace toggle), and prove
// the adjustment is captured on the storefront. The pack page's only card grid
// is the "Top Hits" rail (per-pack Immortal/Legendary/Mythical tiers, priced
// from market_value via GET /store/packs/{slug}) — so the card FMV edit must
// surface there once the card's per-pack tier is top-tier.
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
  setOdds,
} from './helpers/api';
import { primaryPack } from './helpers/catalog';
import {
  ensureAdmin,
  registerCardFromInventory,
  editCard,
} from './helpers/admin';

const PRODUCT_TITLE = 'PW Test Eligible Card';
const CARD_HANDLE = 'pw-test-card';
const BIG_FMV = 99_999;

let admin: string;
// The real entry pack, resolved live — the card is temporarily added to its
// pool and removed again in the `finally` below.
let POOL_PACK = '';
// The eligibility re-check below verifies the lifecycle test's cleanup. The
// lifecycle test hard-fails (not skips) when its fixture is missing, and its
// `finally` block restores the pool + deletes the card even on failure, so
// this check is valid to run unconditionally.

test.beforeAll(async () => {
  admin = await adminToken();
  POOL_PACK = (await primaryPack()).slug;
  // Clean slate: deleting the card (if a prior run left it) makes the product
  // eligible to register again.
  await deleteCardIfExists(admin, CARD_HANDLE);
});

test('card lifecycle: register from inventory → adjust FMV → reflects on storefront', async ({
  page,
}) => {
  // Hard-fail rather than skip: seed:e2e provisions this product in the same
  // CI job, so its absence means the seed regressed, not that the fixture is
  // legitimately missing — a skip here is exactly what kept this spec dark
  // for six weeks.
  const elig = await eligibleProducts(admin);
  expect(
    elig.products.some((p) => p.handle === CARD_HANDLE),
    `Eligible product '${CARD_HANDLE}' missing — seed:e2e (seed-e2e-fixtures.ts) regressed or was not run`,
  ).toBeTruthy();

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
      // New members join at per-pack tier Common (set-pack-members), but the
      // pack page's only card grid is the "Top Hits" rail, which lists ONLY
      // Immortal/Legendary/Mythical tiers — promote the test card so the UI
      // step below can see it. Pcts are echoed verbatim (the new row holds
      // 0%), so the odds budget still sums and the POST validates.
      const rows = (await getOdds(admin, POOL_PACK)).odds;
      await setOdds(
        admin,
        POOL_PACK,
        rows.map((r) => ({
          card_id: r.card_id,
          locked: r.locked,
          pct: r.pct,
          rarity: r.name === PRODUCT_TITLE ? 'Mythical' : r.rarity,
        })),
      );
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
      // The pool section heads "Top Hits" whenever the pack holds any
      // top-tier card — always true here (the shared fixture pool carries a
      // Mythical, plus the test card was promoted above).
      await expect(
        page.getByRole('heading', { name: 'Top Hits' }),
      ).toBeVisible();
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
  // After the lifecycle test's cleanup, the product is un-registered once more.
  const elig = await eligibleProducts(admin);
  expect(elig.products.some((p) => p.handle === CARD_HANDLE)).toBe(true);
});
