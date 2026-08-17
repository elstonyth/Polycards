// Customer workflow, end to end through the storefront UI:
//   create account → top up credits → open a pack → keep the card in the vault
//   → sell it back. Backend ledgers are asserted via API as ground truth.
// Re-authored 2026-07-12 against the redesigned /slots + /vault UI (plan 023):
// the pack detail is a configurator whose "Open Pack" CTA navigates to the slot
// reel (/slots/<slug>/spin), the won card auto-vaults server-side, and top-up
// is the global header-chip sheet. The old /claw reveal theater is retired.
import { test, expect } from '@playwright/test';
import { BASE, stamp } from './helpers/constants';
import { api } from './helpers/api';
import { fundFor, primaryPack } from './helpers/catalog';
import * as sf from './helpers/storefront';

test.describe('customer workflow', () => {
  const id = stamp();
  const username = `pw-cust-${id}`;
  const email = `pw-cust-${id}@polycards.local`;
  const password = 'PwCust2026!';

  test('signup → top up → open → keep → vault → sell-back', async ({
    page,
  }) => {
    // The real catalog's entry pack, read live — no hardcoded slug, and the
    // top-up below scales with whatever that pack costs today.
    const pack = await primaryPack();
    const PACK = pack.slug;
    const fund = fundFor(pack);
    // Pre-accept cookie consent (key: src/lib/consent.ts CONSENT_KEY): the
    // fresh-context banner (z-50, bottom-anchored) overlays the vault's
    // persistent action bar and intercepts the "Sell 1" pill click below.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('polycards.cookie-consent', 'accepted');
      } catch {
        // Cross-origin iframes deny localStorage — only the top frame matters.
      }
    });

    await test.step('create account via the auth modal', async () => {
      await sf.signup(page, PACK, username, email, password);
      // CTA flips from "Log in to open" to "Open Pack" once authenticated.
      await expect(
        page.getByRole('button', { name: /open pack/i }),
      ).toBeVisible();
    });

    await test.step(`top up RM${fund} and see it on the vault balance`, async () => {
      await sf.topUp(page, fund);
      await sf.gotoVault(page);
      // Stat strip shows whole-ringgit; the header chip carries the exact
      // figure — read that as the canonical balance.
      await expect(page.getByText(/^Balance$/).first()).toBeVisible();
      expect(await sf.readBalance(page)).toBe(fund);
    });

    await test.step('open a pack — balance debits by the open cost', async () => {
      await sf.gotoPack(page, PACK);
      const before = await sf.readBalance(page);
      await sf.openPackAndKeep(page);
      // The spin view hides the chrome; leave (to the vault) so the header
      // "Balance … top up" chip is present for the after-read.
      await sf.gotoVault(page);
      const after = await sf.readBalance(page);
      // The exact per-open price is asserted by the backend charge tests; the
      // /slots page shows the price inside the CTA, so here we confirm the spin
      // debited the balance.
      expect(before - after).toBeGreaterThan(0);
    });

    await test.step('kept card appears in the vault', async () => {
      await sf.gotoVault(page);
      await sf.expectVaultHasCard(page);
    });

    await test.step('sell the card back — balance refills', async () => {
      await sf.sellFirstCard(page);
      // The buyback hits the credit ledger; verify the reason landed server-side.
      await expect
        .poll(
          async () => {
            const login = await api<{ token: string }>(
              '/auth/customer/emailpass',
              { method: 'POST', body: { email, password } },
            );
            const credits = await api<{
              transactions: Array<{ reason: string }>;
            }>('/store/credits', { token: login.token });
            return credits.transactions.map((t) => t.reason);
          },
          { timeout: 20_000 },
        )
        .toEqual(expect.arrayContaining(['topup', 'pack_open', 'buyback']));
    });

    await test.step('screenshot the funded vault', async () => {
      await sf.gotoVault(page);
      await page.screenshot({
        path: 'docs/research/pw-customer-vault.png',
        fullPage: true,
      });
    });

    await test.step('log out — the open CTA is gated again', async () => {
      // sf.logout asserts the CTA reverts to "Log in to open".
      await sf.logout(page, PACK);
    });
  });
});

test('anonymous demo spin creates NO backend pull', async ({ page }) => {
  const { slug: PACK } = await primaryPack();
  const newest = (pulls: Array<{ rolled_at: string }>): string | null =>
    pulls[0]?.rolled_at ?? null;
  const before = await api<{ pulls: Array<{ rolled_at: string }> }>(
    '/store/pulls/recent',
  );
  // Guest demo mode lives on the reel at /slots/<slug>/spin?demo=1 (the pack
  // page's "Try a free demo spin" CTA links here). It is pure client-side
  // theater — no charge, no Pull row — which is exactly what this asserts.
  await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('button', { name: /demo spin/i }).click();
  await page.waitForTimeout(3000); // let any (erroneous) write land before re-checking
  const after = await api<{ pulls: Array<{ rolled_at: string }> }>(
    '/store/pulls/recent',
  );
  expect(newest(after.pulls)).toBe(newest(before.pulls));
});
