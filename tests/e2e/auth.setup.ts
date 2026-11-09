// Logs the operator in ONCE and saves the session (and an API token), so the
// rest of the suite reuses them instead of re-authenticating (admin /auth is
// rate-limited — repeated logins trip "Too many sign-in attempts" — and each
// sign-in spends an authenticator code).
import { test as setup } from '@playwright/test';
import { adminLogin, ADMIN_STORAGE } from './helpers/admin';
import { saveAdminToken, signInAdmin } from './helpers/api';
import { assertSeedPacks } from './helpers/seed-guard';

// Every e2e spec depends on this 'setup' project, so it's the one central hook
// where a missing-seed preflight fails the whole run fast (before 9 specs edit
// their own copy of the slug). Independent setup check — does not depend on any
// ordering relative to the admin login below (both must pass before e2e runs).
setup('seed packs present', async () => {
  await assertSeedPacks();
});

setup('authenticate admin', async ({ page }) => {
  // One API token for every spec's adminToken(), then the dashboard session.
  // Each sign-in spends an authenticator code, so the second waits for the
  // next 30-second step.
  await saveAdminToken(await signInAdmin());
  await adminLogin(page);
  await page.context().storageState({ path: ADMIN_STORAGE });
});
