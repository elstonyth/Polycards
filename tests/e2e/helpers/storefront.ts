// Storefront (:4000) page-object helpers. The reveal-theater timing here is
// ported verbatim from the proven scripts/qa-claw-e2e.mjs — the open animation
// has no clean end-signal, so fixed settles are intentional, not laziness.
import { type Page, expect } from '@playwright/test';
import { BASE } from './constants';

export async function gotoPack(page: Page, slug: string): Promise<void> {
  // The pack detail lives at /slots/<slug> now (the /claw route 308-redirects here);
  // navigate directly to skip the redirect round-trip.
  await page.goto(`${BASE}/slots/${slug}`, { waitUntil: 'domcontentloaded' });
}

// Did the auth CTA flip to the logged-in "Open Pack" within `ms`?
async function flippedToOpen(page: Page, ms: number): Promise<boolean> {
  try {
    await page.getByRole('button', { name: /open pack/i }).waitFor({
      timeout: ms,
    });
    return true;
  } catch {
    return false;
  }
}

async function submitSignup(
  page: Page,
  slug: string,
  username: string,
  email: string,
  password: string,
): Promise<void> {
  await gotoPack(page, slug);
  // The redesigned /slots page has no page-level "Sign up" button — auth opens as
  // a modal (login mode) from the "Log in"/"Log in to open" trigger; switch to the
  // signup sub-view via the modal's "Sign up" toggle ("New to Pokenic? Sign up").
  await page
    .getByRole('button', { name: /^log in$|log in to open/i })
    .first()
    .click();
  await page
    .getByRole('button', { name: /^sign up$/i })
    .first()
    .click();
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirmPassword"]', password);
  await page.getByRole('button', { name: /create account/i }).click();
}

async function submitLogin(
  page: Page,
  slug: string,
  email: string,
  password: string,
): Promise<void> {
  await gotoPack(page, slug);
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.press('input[name="password"]', 'Enter');
}

// Create the account via the UI. The backend rate-limits sign-ins, so under
// suite-wide auth pressure the register or the follow-up login can be throttled.
// Alternate create-account / login with a backoff until the CTA flips: whichever
// half got throttled, the next pass completes it (the account exists after a
// successful register even if its login 429'd).
export async function signup(
  page: Page,
  slug: string,
  username: string,
  email: string,
  password: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await submitSignup(page, slug, username, email, password);
    if (await flippedToOpen(page, 12_000)) return;
    await page.waitForTimeout(8_000); // clear the short sign-in window
    await submitLogin(page, slug, email, password);
    if (await flippedToOpen(page, 12_000)) return;
    await page.waitForTimeout(8_000);
  }
  throw new Error('signup never completed — CTA never became "Open Pack"');
}

export async function login(
  page: Page,
  slug: string,
  email: string,
  password: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await submitLogin(page, slug, email, password);
    if (await flippedToOpen(page, 12_000)) return;
    await page.waitForTimeout(8_000);
  }
  throw new Error('login never completed — CTA never became "Open Pack"');
}

export async function logout(page: Page, slug: string): Promise<void> {
  await gotoPack(page, slug);
  await page.locator('header').getByRole('button').last().click();
  await page.getByRole('menuitem', { name: /log out/i }).click();
  // Logout redirects to the home page, so the pack CTA isn't on the current
  // view; reload the pack as a guest to prove it re-gated to "Log in to open"
  // (mirrors the demo journey's logout beat).
  await page.waitForTimeout(1000);
  await gotoPack(page, slug);
  await page
    .getByRole('button', { name: /log in to open/i })
    .waitFor({ timeout: 15_000 });
}

// Current site-credit balance, read from the header chip ("Balance RM X.XX — top up").
// The old "/slots" per-open price line ("Each open costs RM …") was removed in the
// redesign; exact per-open pricing is covered by the backend charge tests.
export async function readBalance(page: Page): Promise<number> {
  const chip = page
    .getByRole('button', { name: /Balance .* top up/i })
    .first();
  await chip.waitFor({ timeout: 15_000 });
  const text = (await chip.textContent()) ?? '';
  const m = text.match(/RM\s*([\d,.]+)/);
  if (!m || m[1] === undefined) {
    throw new Error(`unparsable balance chip: ${text}`);
  }
  return Number(m[1].replace(/,/g, ''));
}

// Legacy compatibility shim for the stale demo recorder (tests/demo) — the /slots
// redesign removed the per-open price line, so price is unavailable here.
export async function readPriceAndBalance(
  page: Page,
): Promise<{ price: number; balance: number }> {
  return { price: NaN, balance: await readBalance(page) };
}

export async function topUp(page: Page, amount: number): Promise<void> {
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  // Top-up is triggered from the header balance chip ("Balance RM 0.00 — top up")
  // in the redesign — the old "Add credits" button is gone.
  await page
    .getByRole('button', { name: /Balance .* top up/i })
    .first()
    .click();
  await page.getByLabel('Top-up amount in RM').fill(String(amount));
  await page
    .getByRole('button', { name: new RegExp(`Proceed.*add RM ${amount}\\.00`) })
    .click();
  // Demo checkout shows an in-modal success state ("RM X ADDED") with a Done
  // button rather than auto-closing — confirm the add, then dismiss.
  await page
    .getByText(new RegExp(`RM ${amount}\\.00 ADDED`, 'i'))
    .waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Done$/ }).click();
}

// Open = spin the slot reel embedded on /slots/<slug>. The reveal-theater
// (Open Pack → cylinder → Keep in vault) was replaced by the slot machine; the
// won card is auto-kept in the server-side vault, so we spin and let the reel
// settle without flipping/selling (an unflipped/unsold card stays vaulted).
export async function openPackAndKeep(page: Page): Promise<void> {
  // /slots/<slug> is a configurator; its "Open Pack RM X" CTA navigates to the
  // reel (/slots/<slug>/spin), which performs the single charge on spin.
  await page.getByRole('button', { name: /^Open Pack/ }).click();
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  // Reel settle has no clean end-signal; the flip button becoming ENABLED is the
  // real "card revealed-ready" marker (ported from slot-vault-room.spec).
  await expect(
    page.getByRole('button', { name: 'Flip to reveal your card' }),
  ).toBeEnabled({ timeout: 30_000 });
}

export async function gotoVault(page: Page): Promise<void> {
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
}

// A vaulted card renders a "Sell for $X (90%)" button — wait for at least one.
export async function expectVaultHasCard(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: /^Sell .* \(90%\)/ }).first(),
  ).toBeVisible({ timeout: 20_000 });
}

// Sell the first vaulted card end-to-end: the grid "Sell for $X" button opens
// the confirm dialog, then the dialog's own "Sell for $X" button fires the
// buyback. Without the second click the modal never confirms and the buyback
// endpoint is never hit (the gap that left the sell-back path untested).
export async function sellFirstCard(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^Sell .* \(90%\)/ })
    .first()
    .click();
  // Scope to the modal (aria-label "Confirm sell-back") so the dialog's confirm
  // button is unambiguous vs. the grid buttons behind it.
  const dialog = page.getByRole('dialog', { name: 'Confirm sell-back' });
  // The grid button reads "Sell · RM X (90%)"; the dialog's confirm button reads
  // "Sell for RM X" (no percent) — match it specifically.
  await dialog.getByRole('button', { name: /^Sell for RM/ }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}
