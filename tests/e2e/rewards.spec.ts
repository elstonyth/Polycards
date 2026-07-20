// Customer rewards workflow after the daily-box move onto /vip: claim a VIP
// voucher grant on /vip, then open the daily box (also on /vip — /daily now
// redirects there).
//
// PRECONDITIONS (the "reward gate" phase):
//   1. backend running with REWARDS_REDEMPTION_ENABLED=true — the nightly's
//      e2e.yml sets this at the job env; locally, export it before starting
//      medusa. When it's off the "Claim" button reads "Coming soon" and the
//      voucher test SKIPS rather than fails.
//   2. seed:e2e (seed-e2e-fixtures.ts) mints a 'granted' VIP voucher for the
//      shared dev customer (test@polycards.app) — no other seed path does. For
//      the daily box, seed-reward-economy-demo.ts authors the tier-c box.
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import * as sf from './helpers/storefront';

const PACK = process.env.PW_REWARD_PACK ?? 'pokemon-rookie';
const EMAIL = process.env.PW_REWARD_EMAIL ?? 'test@polycards.app';
const PASSWORD = process.env.PW_REWARD_PASSWORD ?? 'PolycardsTest123!';

// SUSPENDED 2026-07-29 — both routes this spec drives (`/vip`, `/daily`) were
// deleted with the reward-surface suspension
// (docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md),
// so every step here would time out against a 404. Skipped rather than deleted:
// the suspension is meant to be revertible, and this spec is the coverage that
// comes back with it. Un-skip when the reward surfaces return.
test.describe.skip('customer rewards — voucher + daily box on /vip', () => {
  test('claim a voucher grant on /vip', async ({ page }) => {
    await sf.login(page, PACK, EMAIL, PASSWORD);
    await page.goto(`${BASE}/vip`, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: /vouchers/i })
      .waitFor({ timeout: 15_000 });

    const gated = await page
      .getByRole('button', { name: /coming soon/i })
      .first()
      .isVisible()
      .catch(() => false);
    test.skip(
      gated,
      'reward redemption disabled (REWARDS_REDEMPTION_ENABLED unset — the ' +
        'nightly sets it in e2e.yml; export it locally to exercise this)',
    );

    const claim = page
      .getByRole('button', { name: 'Claim', exact: true })
      .first();
    const hasClaimable = await claim.isVisible().catch(() => false);
    test.skip(!hasClaimable, 'no claimable voucher grants on this account');
    await claim.click();
    await expect(page.getByText('Claimed').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('open the daily box on /vip (/daily redirects there)', async ({
    page,
  }) => {
    await sf.login(page, PACK, EMAIL, PASSWORD);
    // The daily box moved onto /vip; /daily is now a redirect to it.
    await page.goto(`${BASE}/daily`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/vip$/, { timeout: 15_000 });

    const openBox = page.getByRole('button', { name: /open box/i });
    if (await openBox.isEnabled().catch(() => false)) {
      await openBox.click();
      const reveal = page.getByRole('dialog', { name: /daily box reveal/i });
      await reveal.waitFor({ timeout: 20_000 });
      await reveal.getByRole('button', { name: /continue/i }).click();
      await expect(reveal).toBeHidden({ timeout: 15_000 });
    }
  });
});
