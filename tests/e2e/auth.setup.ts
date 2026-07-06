// Logs the operator in ONCE and saves the session, so the rest of the suite
// reuses it via storageState instead of re-authenticating (admin /auth is
// rate-limited — repeated logins trip "Too many sign-in attempts").
import { test as setup } from '@playwright/test';
import { adminLogin, ADMIN_STORAGE } from './helpers/admin';

setup('authenticate admin', async ({ page }) => {
  await adminLogin(page);
  await page.context().storageState({ path: ADMIN_STORAGE });
});
