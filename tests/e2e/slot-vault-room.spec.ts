// Vault Room slot machine, end to end through the storefront UI:
//   spin → reel settles → the slab appears face-down (sell footer flip-gated)
//   → flip → "Sell for RM…" appears → confirm sell-back → credit ledger gains
//   a buyback row (server truth). Plus: leaving a flipped card unsold until the
//   shared 30s window expires auto-vaults it (instant button disappears, vault
//   copy appears).
// Login goes through the existing /claw/<slug> CTA (sf.login) — auth is a
// global session, so navigating on to /slots/<slug>/spin afterwards carries
// the same signed-in customer. Two spins total across the whole spec (opens
// are rate-limited and spend real local credits).
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import { api, createCustomer } from './helpers/api';
import * as sf from './helpers/storefront';

const PACK = 'pokemon-rookie';
// createCustomer() registers every customer with this fixed password.
const PASSWORD = 'PwE2e2026!';

const FLIP_BUTTON = { name: 'Flip to reveal your card' };
const SELL_BUTTON = { name: /^Sell for RM/ };

async function spinAndSettle(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/slots/${PACK}/spin?count=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  // Reel settle has no clean end-signal beyond the slab appearing — but the
  // flip button renders (disabled) during the 'transform' phase already, so
  // waiting for mere presence races the review-phase enable. Wait for it to
  // become enabled instead — that's the real "ready to flip" signal.
  await expect(page.getByRole('button', FLIP_BUTTON)).toBeEnabled({
    timeout: 30_000,
  });
}

test.describe('slot vault room', () => {
  test('spin → flip → instant sell → server-truth ledger row', async ({
    page,
  }) => {
    const cust = await createCustomer(200);
    await sf.login(page, PACK, cust.email, PASSWORD);

    await test.step('spin and let the reel settle on the face-down slab', async () => {
      await spinAndSettle(page);
    });

    await test.step('no sell button before the flip', async () => {
      await expect(page.getByRole('button', SELL_BUTTON)).toHaveCount(0);
    });

    await test.step('flip the card — the instant sell button appears', async () => {
      // force: true — the unflipped card has a perpetual idle float
      // (translateY loop in SlabCard), so Playwright's actionability
      // stability check can spin forever waiting for it to stop moving. The
      // enabled-wait in spinAndSettle already proves it's genuinely clickable.
      await page.getByRole('button', FLIP_BUTTON).click({ force: true });
      await expect(page.getByRole('button', SELL_BUTTON)).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('confirm the sell in the shared modal', async () => {
      await page.getByRole('button', SELL_BUTTON).click();
      const dialog = page.getByRole('dialog', { name: 'Confirm sell-back' });
      await expect(dialog.getByText(/Sell this card\?/i)).toBeVisible();
      await dialog.getByRole('button', { name: /^Sell for RM/ }).click();
      await expect(dialog).toBeHidden({ timeout: 20_000 });
    });

    await test.step('server truth: a buyback row lands on the credit ledger', async () => {
      await expect
        .poll(
          async () => {
            const credits = await api<{
              transactions: Array<{ reason: string }>;
            }>('/store/credits', { token: cust.token });
            return credits.transactions.filter((t) => t.reason === 'buyback')
              .length;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(1);
    });
  });

  test('unsold flipped card auto-vaults at window expiry', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const cust = await createCustomer(200);
    await sf.login(page, PACK, cust.email, PASSWORD);

    await test.step('second spin, settle, flip — do not sell', async () => {
      await spinAndSettle(page);
      await page.getByRole('button', FLIP_BUTTON).click({ force: true });
      await expect(page.getByRole('button', SELL_BUTTON)).toBeVisible({
        timeout: 10_000,
      });
    });

    // The shared 30s window is server-anchored (instant_deadline_ms from the
    // reveal ping) — no test-mode short deadline, so this genuinely waits it
    // out on the real wall clock rather than mocking page.clock (which would
    // fight the rAF reel engine).
    await test.step('wait out the real 30s window — vault copy replaces the sell button', async () => {
      await expect(page.getByText(/Stored in your vault/i)).toBeVisible({
        timeout: 40_000,
      });
      await expect(page.getByRole('button', SELL_BUTTON)).toHaveCount(0);
    });
  });
});
