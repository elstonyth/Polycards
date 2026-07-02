// Headed preview of the PriceCharting pricing rework: logs into the admin,
// walks Add-from-PriceCharting live (needs the token injected by launch-stack),
// shows the register-card autofill + margin, and the storefront pack detail.
// Screenshots land in SHOT_DIR; the browser stays open for a human look.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';

const SHOT_DIR = process.env.SHOT_DIR ?? '.';
const ADMIN_BASE = 'http://localhost:7000/dashboard';
const STORE = 'http://127.0.0.1:3001';

// Creds from the gitignored .dev-logins (never printed).
const logins = Object.fromEntries(
  readFileSync(new URL('./.dev-logins', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);
const ADMIN_EMAIL = logins.ADMIN_EMAIL ?? 'admin@pokenic.app';
const ADMIN_PW = logins.ADMIN_PW;
if (!ADMIN_PW) {
  console.log('NO ADMIN_PW in scripts/.dev-logins — aborting');
  process.exit(1);
}

const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });

const log = (m) => console.log(`[preview] ${m}`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});

// ── Tab 1: admin — Add from PriceCharting ────────────────────────────────────
const admin = await ctx.newPage();
await admin.goto(`${ADMIN_BASE}/login`, {
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});
await admin.fill('input[name="email"]', ADMIN_EMAIL);
await admin.fill('input[name="password"]', ADMIN_PW);
await admin.keyboard.press('Enter');
await admin.waitForURL((u) => !u.pathname.includes('/login'), {
  timeout: 20000,
});
log('admin logged in');

await admin.goto(`${ADMIN_BASE}/products/from-pricecharting`, {
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});
await admin.waitForSelector('text=Add from PriceCharting', { timeout: 15000 });

// Live search (uses the real PriceCharting API via the backend proxy).
await admin.fill('input[placeholder*="Card name"]', 'pikachu 288');
await admin.keyboard.press('Enter');
try {
  await admin.waitForSelector('button:has-text("Pikachu")', { timeout: 20000 });
  await admin.click('button:has-text("Pikachu #288")');
  // Tier chips appear once per-grade prices load.
  await admin.waitForSelector('button:has-text("PSA 10:")', { timeout: 20000 });
  await admin.click('button:has-text("PSA 10:")');
  await admin.waitForTimeout(800); // let the preview line + image settle
  log('picked Pikachu #288 PSA 10 tier');
} catch (e) {
  log(
    `live PC search unavailable (${e.message.split('\n')[0]}) — screenshotting page as-is`,
  );
}
await shot(admin, 'preview-1-add-from-pc.png');
// Scroll to the pixel Pokémon + submit section.
await admin.keyboard.press('End');
await admin.waitForTimeout(500);
await shot(admin, 'preview-2-add-from-pc-bottom.png');
log('add-from-pc screenshots saved');

// ── Tab 2: admin — register-card modal (autofill + margin) ──────────────────
const cards = await ctx.newPage();
await cards.goto(`${ADMIN_BASE}/cards`, {
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});
try {
  await cards.waitForSelector('button:has-text("Add from inventory")', {
    timeout: 15000,
  });
  await cards.click('button:has-text("Add from inventory")');
  await cards.waitForSelector('text=Add card from inventory', {
    timeout: 10000,
  });
  await cards.waitForTimeout(1500); // eligible list load
  // Pick the first eligible product if any — shows the autofill + margin field.
  const row = cards.locator('div.max-h-64 button').first();
  if (await row.count()) {
    await row.click();
    await cards.waitForTimeout(500);
  }
  await shot(cards, 'preview-3-register-modal.png');
  log('register modal screenshot saved');
} catch (e) {
  log(`register modal: ${e.message.split('\n')[0]}`);
  await shot(cards, 'preview-3-register-modal.png');
}

// ── Tab 3: storefront pack detail (Top Hits in live MYR) ────────────────────
const store = await ctx.newPage();
try {
  await store.goto(`${STORE}/claw`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await store.waitForTimeout(2500);
  const packLink = store.locator('a[href^="/claw/"]').first();
  if (await packLink.count()) {
    await packLink.click();
    await store.waitForTimeout(3000);
  }
  await shot(store, 'preview-4-storefront-pack.png');
  log('storefront screenshot saved');
} catch (e) {
  log(`storefront: ${e.message.split('\n')[0]}`);
}

log('READY — browser stays open for inspection');
// Keep the process (and browser) alive until closed by the user.
await new Promise(() => {});
