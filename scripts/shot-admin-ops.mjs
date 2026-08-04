// scripts/shot-admin-ops.mjs — capture the admin surfaces changed by the
// feat/admin-ops-batch branch, for the review artifact.
//
// Run from the repo ROOT (so @playwright/test resolves), with the stack up:
//   pwsh scripts/launch-stack.ps1
//   node scripts/shot-admin-ops.mjs
//
// Password comes from env ONLY (the launch script injects it from the
// gitignored scripts/.dev-logins); the email is a non-secret default.
// Env: ADMIN_BASE, ADMIN_EMAIL, ADMIN_PW, SHOT_CUSTOMER (ungrouped player id)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const ADMIN = process.env.ADMIN_BASE ?? 'http://localhost:7000/dashboard';
const OP = {
  email: process.env.ADMIN_EMAIL ?? 'admin@pokenic.app',
  password: process.env.ADMIN_PW ?? '',
};
const CUSTOMER = process.env.SHOT_CUSTOMER ?? '';
const OUT = 'docs/research/shots';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Same retry-the-whole-flow shape as login-stack.mjs: a bare fill before the
// form has hydrated throws uncaught and kills the run.
async function adminLogin(page) {
  for (let i = 0; i < 4; i++) {
    try {
      await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
      const email = page.locator('input[name="email"]');
      await email.waitFor({ state: 'visible', timeout: 30000 });
      await email.fill(OP.email);
      await page.fill('input[name="password"]', OP.password);
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => !u.pathname.includes('login'), {
        timeout: 20000,
      });
      return true;
    } catch (e) {
      log(
        `login attempt ${i + 1} failed (${String(e.message).split('\n')[0]}), retrying…`,
      );
      await page.waitForTimeout(3000);
    }
  }
  return false;
}

const shots = [];
// Screenshot the CARD, not the viewport: a full-page shot of a 1560px admin
// buries the changed surface under half a screen of empty background.
//
// `maxHeight` caps a long list at the rows that make the point — a 5000px-tall
// table shrinks to an unreadable strip once the artifact scales it to column
// width, which defeats the purpose of taking it.
async function shot(page, name, locator, maxHeight) {
  const file = `${OUT}/${name}.png`;
  const target = locator ?? page;
  if (maxHeight && locator) {
    const box = await locator.boundingBox();
    await page.screenshot({
      path: file,
      clip: { ...box, height: Math.min(box.height, maxHeight) },
    });
  } else {
    await target.screenshot({ path: file });
  }
  shots.push(name);
  log('shot', name);
}

/** The page's outermost card — every one of these routes renders a single
 *  <Container> as main's first child. */
const card = (page) => page.locator('main').locator('> *').first();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 1000 },
  deviceScaleFactor: 2, // retina, so the artifact stays legible when scaled
  colorScheme: 'dark',
});
// The dashboard reads its own theme from localStorage, not the OS preference —
// colorScheme alone leaves it light, which is not what the operator sees.
await ctx.addInitScript(() => {
  window.localStorage.setItem('medusa_admin_theme', 'dark');
});
const page = await ctx.newPage();

if (!OP.password) {
  log('ADMIN_PW not set — cannot log in');
  process.exit(1);
}
if (!(await adminLogin(page))) {
  log('admin login FAILED');
  process.exit(1);
}
log('logged in');

// ── 1. Weekly Challenge: the new three-tab header + Scheduled tab ────────────
await page.goto(`${ADMIN}/challenge`, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: 'Scheduled' }).click();
await page
  .getByText('Weekly challenges waiting to go live')
  .waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
await shot(page, 'challenge-scheduled-tab', card(page));

// The Add-weekly-challenge modal, with the ladder seeded from the live one.
await page.getByRole('button', { name: 'Add weekly challenge' }).click();
const modal = page.getByRole('dialog');
await modal
  .getByRole('heading', { name: 'Add weekly challenge' })
  .waitFor({ timeout: 20000 });
await page.waitForTimeout(900);
// Capped: the FocusModal is full-viewport, and everything below the Reason
// field is empty backdrop.
await shot(page, 'challenge-add-modal', modal, 930);

// Expanded stage 1, showing the per-rank prize table the modal shares with the
// live tab. Scoped to the MODAL: the hidden "This week" panel is forceMounted,
// so an unscoped locator resolves to its (invisible) toggle and hangs.
const toggle = modal.locator('[data-pc-stage-toggle]').first();
if (await toggle.count()) {
  await toggle.click();
  await page.waitForTimeout(900);
  await shot(page, 'challenge-add-modal-ranks', modal, 980);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Winners: settled history, including the out-of-stock cards that are the only
// reason the manual-fulfilment queue is visible anywhere.
await page.getByRole('tab', { name: 'Winners' }).click();
await page.getByText('Every settled week').waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
await shot(page, 'challenge-winners-tab', card(page));

// ── 2. All Orders: the new Topups tab ────────────────────────────────────────
await page.goto(`${ADMIN}/deliveries`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await shot(page, 'orders-tabs-shipping', card(page));
await page.getByRole('tab', { name: 'Topups' }).click();
await page.waitForTimeout(1400);
await shot(page, 'orders-topups-tab', card(page));

// ── 3. Player group: DEFAULT for a player with no stored membership ──────────
if (CUSTOMER) {
  await page.goto(`${ADMIN}/customers/${CUSTOMER}`, {
    waitUntil: 'networkidle',
  });
  const groupHeading = page.getByRole('heading', { name: 'Player group' });
  await groupHeading.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  // Walk up to the enclosing <Container> by its @medusajs/ui class rather than
  // indexing main's children: this route nests its cards inside a tab panel, so
  // the group card is not a direct child of main.
  await shot(
    page,
    'customer-default-group',
    groupHeading.locator(
      'xpath=ancestor::div[contains(@class,"shadow-elevation-card-rest")][1]',
    ),
  );
}

// ── 4. Players list: the group column ────────────────────────────────────────
// Widened first: the group column sits mid-table, and at 1560 the row runs off
// the right edge, cropping the very column the change is about.
await page.setViewportSize({ width: 1900, height: 1000 });
await page.goto(`${ADMIN}/players`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await shot(page, 'players-group-column', card(page), 470);

log('DONE', shots.join(', '));
await browser.close();
