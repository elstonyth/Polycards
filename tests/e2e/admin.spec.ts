// Admin management workflow through the dashboard UI:
//   login → cards catalog → packs catalog → create a pack → manage its pool
//   → adjust a customer's credits (support) → economy report.
import { test, expect } from '@playwright/test';
import { ADMIN, stamp } from './helpers/constants';
import { adminToken, api, createCustomer, openPack } from './helpers/api';
import { ensureAdmin, createPack } from './helpers/admin';

test.describe('admin workflow', () => {
  test.beforeEach(async ({ page }) => {
    await ensureAdmin(page);
  });

  test('cards + packs catalogs render with management actions', async ({
    page,
  }) => {
    await page.goto(`${ADMIN}/cards`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('table tbody tr').first()).toBeVisible({
      timeout: 20_000,
    });
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);

    await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('table tbody tr').first()).toBeVisible({
      timeout: 20_000,
    });
    // Management actions present on each pack row.
    await expect(
      page.getByRole('button', { name: 'Pool & odds' }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Edit' }).first(),
    ).toBeVisible();
  });

  test('create a pack and manage its prize pool', async ({ page }) => {
    const slug = `pw-pack-${stamp()}`;
    const title = `PW Test Pack ${slug}`;

    await createPack(page, {
      slug,
      title,
      price: 30,
      imageUrl: '/cdn/packs/pokemon-rookie.webp',
    });

    // Appears in the list UI…
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
    // …and is persisted server-side.
    const token = await adminToken();
    const { packs } = await api<{ packs: Array<{ slug: string }> }>(
      '/admin/packs',
      { token },
    );
    expect(packs.map((p) => p.slug)).toContain(slug);

    // New pack starts with an empty pool — add cards through "Manage cards".
    await page.goto(`${ADMIN}/packs/${slug}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('button', { name: 'Manage cards' }).click();
    const checks = page.getByRole('checkbox');
    await checks.first().waitFor({ timeout: 15_000 });
    await checks.nth(0).click();
    await checks.nth(1).click();
    await page.getByRole('button', { name: 'Save pool' }).click();
    // Pool rows now render in the odds editor.
    await expect(page.locator('tbody tr').first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await page.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);

    // Delete the throwaway pack through the UI (row Delete → confirm prompt).
    await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
    const row = page.locator('tbody tr', { hasText: title });
    await row
      .first()
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await page.getByRole('button', { name: 'Delete pack' }).click();
    await expect(page.getByText('Pack deleted.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(title)).toHaveCount(0);

    // …and it's gone server-side.
    const after = await api<{ packs: Array<{ slug: string }> }>(
      '/admin/packs',
      { token },
    );
    expect(after.packs.map((p) => p.slug)).not.toContain(slug);
  });

  test('pulls ledger lists opened packs with status', async ({ page }) => {
    // Self-contained: the ledger lists pulls, but the 2026-07 catalog cutover
    // removed the seed's demo pulls and this spec can run before any
    // pack-opening spec — so open one pack up front. An API open auto-vaults
    // the pull, giving it the "In vault" status the ledger asserts below.
    const cust = await createCustomer(100);
    await openPack(cust.token, 'pokemon-rookie');

    // The standalone "/pulls" page was retired ATOMICALLY in #271 (POLYCARD-BACK
    // epic 2, spec D6, commit 87c7e148): the ledger relocated into the Customer
    // 360 detail's "Pulls" tab (routes/customers/[id]/page.tsx → PullsTable) —
    // there is no cross-customer ledger view left to navigate to directly.
    // Reach it the way an operator does: find the customer via Support, open
    // their 360, then the Pulls tab (same search flow the "adjust a customer
    // credit balance" test below already exercises).
    await page.goto(`${ADMIN}/support`, { waitUntil: 'domcontentloaded' });
    await page.locator('#support-q').fill(cust.email);
    await page.getByRole('button', { name: /^search$/i }).click();
    const result = page.getByText(cust.email).first();
    await result.waitFor({ timeout: 15_000 });
    await result.click();
    await page.getByRole('button', { name: 'View 360' }).click();
    await page.getByRole('tab', { name: 'Pulls' }).click();

    await expect(page.locator('table tbody tr').first()).toBeVisible({
      timeout: 20_000,
    });
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
    // Status badges: "In vault" and/or "Bought back" appear in the ledger.
    await expect(
      page.getByText(/in vault|bought.?back/i).first(),
    ).toBeVisible();
  });

  test('adjust a customer credit balance from support', async ({ page }) => {
    // Fresh customer so the assertion is deterministic regardless of history.
    const cust = await createCustomer(20);

    await page.goto(`${ADMIN}/support`, { waitUntil: 'domcontentloaded' });
    await page.locator('#support-q').fill(cust.email);
    await page.getByRole('button', { name: /^search$/i }).click();
    const result = page.getByText(cust.email).first();
    await result.waitFor({ timeout: 15_000 });
    await result.click();

    await expect(page.getByText(/credit balance/i)).toBeVisible({
      timeout: 15_000,
    });
    const balText =
      (await page.locator('h1.tabular-nums').first().textContent()) ?? '';
    const before = Number(balText.replace(/[^0-9.]/g, ''));

    await page.getByLabel(/amount/i).fill('5');
    await page.getByLabel(/note/i).fill('PW E2E adjustment');
    await page.getByRole('button', { name: /apply adjustment/i }).click();
    await page.getByRole('button', { name: /^apply$/i }).click();

    await expect
      .poll(
        async () => {
          const t =
            (await page.locator('h1.tabular-nums').first().textContent()) ?? '';
          return Math.round(Number(t.replace(/[^0-9.]/g, '')) * 100);
        },
        { timeout: 15_000 },
      )
      .toBe(Math.round((before + 5) * 100));

    await expect(page.getByText('PW E2E adjustment')).toBeVisible();
  });

  test('economy report renders lifetime stats and RTP', async ({ page }) => {
    await page.goto(`${ADMIN}/economy`, { waitUntil: 'domcontentloaded' });
    // Scope to the <main> content landmark (@mercurjs/admin's Shell wraps the
    // route Outlet in <main>, sibling to the sidebar's <nav>/<aside> — verified
    // against the installed 2.1.6 bundle). The sidebar's "Payouts" entry is
    // CSS-hidden (admin-ui.css §2.1, display:none) but the node stays in the
    // DOM, so an unscoped getByText(...).first() can latch onto the hidden
    // sidebar anchor instead of the visible stat on this page.
    const main = page.getByRole('main');
    for (const stat of [/revenue/i, /payouts/i, /vault liability/i]) {
      await expect(main.getByText(stat).first()).toBeVisible({
        timeout: 15_000,
      });
    }
    expect(await main.locator('table tbody tr').count()).toBeGreaterThan(0);
  });
});
