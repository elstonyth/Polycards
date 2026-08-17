// First-visit vault: while the cookie-consent banner is undecided it docks
// exactly where the persistent action bar lives (banner z-50 over bar z-40),
// so the bar stays hidden until the visitor answers — then appears at once
// (CONSENT_EVENT, no reload needed). Follow-up from the always-on-selection
// review; the other vault specs pre-seed consent and never see this state.
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import { createCustomer, openPack } from './helpers/api';
import { fundFor, primaryPack } from './helpers/catalog';
import * as sf from './helpers/storefront';

// createCustomer() registers every customer with this fixed password.
const PASSWORD = 'PwE2e2026!';

test('action bar waits for cookie consent, then appears without reload', async ({
  page,
}) => {
  const pack = await primaryPack();
  const PACK = pack.slug;
  const cust = await createCustomer(fundFor(pack));
  await openPack(cust.token, PACK); // auto-vaults the pull
  // No consent pre-seed: this spec exists to exercise the undecided state.
  await sf.login(page, PACK, cust.email, PASSWORD);

  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });

  // Undecided: the banner is up and the bar (its Select All control) is not.
  const banner = page.getByRole('dialog', { name: 'Cookie consent' });
  const selectAll = page.getByRole('button', { name: /^Select All/ });
  await expect(banner).toBeVisible();
  await expect(selectAll).toHaveCount(0);

  // Accept → banner leaves and the bar appears in place, same tab, no reload.
  await banner.getByRole('button', { name: 'Accept' }).click();
  await expect(banner).toBeHidden();
  await expect(selectAll).toBeVisible();
});
