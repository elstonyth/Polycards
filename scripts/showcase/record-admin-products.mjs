// Showcase recording — ADMIN product lifecycle (:7000 dashboard + :9000 API).
// Products (catalog) → register as Gacha Card → create a Pack → set pool & odds.
//
// The demo product is provisioned via the admin API (the multi-step create wizard
// is too brittle to record cleanly, and a card only needs the product to EXIST —
// drafts are eligible). Everything after (register, pack, odds) is real UI. The
// product/card/pack are deleted again at the end (cleanup).
// Run: node scripts/showcase/record-admin-products.mjs → docs/showcase/admin-products.{webm,mp4}
import {
  startSession,
  finishSession,
  caption,
  moveClick,
  sleep,
} from './lib.mjs';
import {
  adminToken,
  adminUiLogin,
  requireAdminTotp,
} from '../lib/admin-sign-in.mjs';

const ADMIN = 'http://localhost:7000';
const BE = 'http://localhost:9000';
const EMAIL = 'qa-admin@polycards.local';
const PASSWORD = 'QaAdmin2026!';

const PRODUCT_TITLE = 'Showcase Charizard VMAX 2025';
const PRODUCT_HANDLE = 'showcase-charizard-vmax-2025';
const PACK_SLUG = 'showcase-demo-pack';
const PACK_TITLE = 'Showcase Demo Pack';

// ── admin API helpers (seed + cleanup) ──────────────────────────────────────
async function api(t, method, path, body) {
  const r = await fetch(`${BE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${t}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function cleanup(t) {
  // pack (custom route, by slug), card (by handle), product (by id)
  await api(t, 'DELETE', `/admin/packs/${PACK_SLUG}`).catch(() => {});
  await api(t, 'DELETE', `/admin/cards/${PRODUCT_HANDLE}`).catch(() => {});
  const found = await api(
    t,
    'GET',
    `/admin/products?handle=${PRODUCT_HANDLE}&limit=5`,
  );
  for (const p of found.json?.products ?? []) {
    await api(t, 'DELETE', `/admin/products/${p.id}`).catch(() => {});
  }
}
async function seed(t) {
  await cleanup(t); // idempotent: clear any leftovers from a prior run
  const res = await api(t, 'POST', '/admin/products', {
    title: PRODUCT_TITLE,
    handle: PRODUCT_HANDLE,
    status: 'draft',
    // a card requires the product to have an image — set one so registration works
    thumbnail: '/home/hero/slabs/pokemon1.webp',
    images: [{ url: '/home/hero/slabs/pokemon1.webp' }],
    options: [{ title: 'Type', values: ['Single'] }],
    variants: [
      {
        title: 'Single',
        options: { Type: 'Single' },
        prices: [{ amount: 250, currency_code: 'usd' }],
      },
    ],
  });
  console.log(
    'seed product:',
    res.status,
    res.json?.product?.handle ?? JSON.stringify(res.json).slice(0, 160),
  );
}

// ── typing helper (clear + visible typing) ──────────────────────────────────
function typer(page) {
  return async (target, text) => {
    const el = typeof target === 'string' ? page.locator(target) : target;
    await moveClick(page, el);
    await el.fill('');
    await el.pressSequentially(text, { delay: 40 });
    await sleep(page, 250);
  };
}

requireAdminTotp(EMAIL);
const t = await adminToken(BE, EMAIL, PASSWORD);
await seed(t);

const s = await startSession();
const { page } = s;
const typeInto = typer(page);
// Auto-accept any native discard/confirm dialog (e.g. leaving the create wizard).
page.on('dialog', (d) => d.accept().catch(() => {}));

try {
  // login: password, then the authenticator code (#996)
  await adminUiLogin(page, ADMIN, EMAIL, PASSWORD);
  await caption(page, 'Operator dashboard — product lifecycle');
  await sleep(page, 1200);

  // 1) PRODUCTS — the catalog
  await caption(page, '1. Products — the catalog (inventory-first)');
  await page.goto(`${ADMIN}/products`, { waitUntil: 'domcontentloaded' });
  await sleep(page, 2000);
  await typeInto('input[name="q"]', 'Showcase Charizard');
  await sleep(page, 2000); // list filters to our new product

  await caption(page, 'Add a product — title, handle, variants & inventory');
  await page.goto(`${ADMIN}/products/create`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(page, 1800);
  await page
    .getByTestId('product-create-general-section-title-input')
    .first()
    .fill(PRODUCT_TITLE);
  await sleep(page, 500);
  await page
    .getByTestId('product-create-general-section-subtitle-input')
    .first()
    .fill('Scarlet & Violet · PSA 10');
  await sleep(page, 1800);
  // (the product is provisioned via API for reliability — leave the wizard;
  // the next goto abandons it, and any discard dialog is auto-accepted.)

  // 2) GACHA CARDS — register the product as a pullable card
  await caption(page, '2. Register it as a pullable Gacha Card');
  await page.goto(`${ADMIN}/cards`, { waitUntil: 'domcontentloaded' });
  await sleep(page, 1500);
  await moveClick(
    page,
    page.getByRole('button', { name: /add from inventory/i }),
  );
  await sleep(page, 1200);
  await typeInto(
    page.getByPlaceholder('Filter products…'),
    'Showcase Charizard',
  );
  await sleep(page, 1200);
  await moveClick(page, page.getByText(PRODUCT_TITLE).first());
  await sleep(page, 800);

  await caption(page, 'Set the fair-market value');
  const dlg = page
    .locator('[role="dialog"]')
    .filter({ hasText: 'Add card from inventory' })
    .last();
  // FMV (the only required gacha fact — name/image come from the product).
  await typeInto(dlg.locator('input[type="number"]').first(), '250');
  await sleep(page, 600);
  await moveClick(page, page.getByRole('button', { name: /register card/i }));
  await sleep(page, 1800);

  // 3) GACHA PACKS — create a pack
  await caption(page, '3. Create a pack');
  await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
  await sleep(page, 1500);
  await moveClick(page, page.getByRole('button', { name: /new pack/i }));
  await sleep(page, 1200);
  const pdlg = page.locator('[role="dialog"]').last();
  // Medusa UI text inputs carry NO `type` attr; untyped order: [0] image, [1] slug, [2] title
  await typeInto(
    pdlg.locator('input:not([type])').nth(0),
    '/home/hero/slabs/pokemon1.webp',
  ); // image (required)
  await typeInto(page.getByPlaceholder('legend-pack'), PACK_SLUG);
  await typeInto(pdlg.locator('input:not([type])').nth(2), PACK_TITLE);
  // number inputs (type="number"): [0] price, [1] rank, [2] buyback %
  const nums = pdlg.locator('input[type="number"]');
  await typeInto(nums.nth(0), '25');
  await typeInto(nums.nth(2), '92').catch(() => {});
  await moveClick(page, page.getByRole('button', { name: /^save$/i }));
  await sleep(page, 1800);

  // pool & odds — add our card to the pool via the API (the in-modal checklist
  // is a long un-searchable list; reliable to set membership server-side), then
  // show the pool + set odds on camera.
  await api(t, 'POST', `/admin/packs/${PACK_SLUG}/members`, {
    card_ids: [PRODUCT_HANDLE],
  });
  await caption(page, 'Set the prize pool & win-rate odds');
  await page.goto(`${ADMIN}/packs/${PACK_SLUG}`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(page, 1800);
  // open the pool list (now shows our card selected), re-save, then save odds
  await moveClick(
    page,
    page.getByRole('button', { name: /manage cards/i }).first(),
  ).catch(() => {});
  await sleep(page, 1500);
  await moveClick(page, page.getByRole('button', { name: /save pool/i })).catch(
    () => {},
  );
  await sleep(page, 1500);
  await moveClick(
    page,
    page.getByRole('button', { name: /save win rates/i }).first(),
  ).catch(() => {});
  await sleep(page, 1500);

  await caption(page, 'Product → Card → Pack — full lifecycle ✓');
  await sleep(page, 2200);
  await caption(page, '');
  await sleep(page, 500);

  console.log('admin-products flow recorded');
} finally {
  await finishSession(s, 'admin-products');
  await cleanup(t); // remove the demo product/card/pack
  console.log('cleanup done');
}
