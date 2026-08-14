// Free welcome pack — storefront QA on the PROD build (never `next dev`).
//
// Walks the whole claim loop as a brand-new customer:
//   /slots badge visible → free detail shows "Open Free Pack" and NO price/qty
//   → spin & open → reveal shows the lock note and NO sell button
//   → /vault shows the locked overlay and refuses selection
//   → /slots badge is gone (the claim is spent).
//
// Setup is idempotent: it (re)creates an ACTIVE free_welcome pack over existing
// cards through the admin API, so a fresh DB needs no hand-seeding.
//
// Run (worktree serves on 4100 — the main tree may hold 4000):
//   npm run build
//   pwsh scripts/serve-standalone.ps1 -Port 4100     # background
//   corepack yarn dev                                # backend/packages/api, :9000
//   QA_ADMIN_EMAIL=... QA_ADMIN_PASSWORD=... node scripts/qa-free-pack.mjs
//
// Admin credentials come from env (repo rule: no hardcoded secrets) — the same
// convention as scripts/qa-locked-wins.mjs. Any local super-admin works, e.g.
// one made with `corepack yarn medusa user -e ... -p ...`.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const API = process.env.QA_API ?? 'http://localhost:9000';
const SLUG = 'qa-free-welcome';
// A paid control for the breakpoint matrix — free mode is a layout fork, so the
// ordinary money page has to be checked at the same two widths.
const PAID_SLUG = process.env.QA_PAID_PACK ?? 'bronze-pack';
const PASSWORD = 'QaFreePack123!';
// Minimum breathing room between the floating badge and the nearest catalog
// control once the page is scrolled to the end (CatalogClient reserves the
// badge's rail as bottom padding). 16px = the badge's own `right-4` inset —
// the page's smallest deliberate gutter, so anything under it reads as the
// badge sitting ON the controls rather than beside it.
const MIN_BADGE_GAP = 16;
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD (dev admin login).');
  process.exit(1);
}

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);
const shot = (page, name) =>
  page.screenshot({ path: `docs/research/qa-free-pack-${name}.png` });

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
};

// ── Setup: an active free_welcome pack + a brand-new customer ───────────────
const admin = await fetch(`${API}/auth/user/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
}).then(json);
if (!admin.token) throw new Error('admin auth failed — check QA_ADMIN_*');
const AH = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${admin.token}`,
};

const keys = await fetch(`${API}/admin/api-keys?type=publishable`, {
  headers: AH,
}).then(json);
const PK = keys.api_keys?.[0]?.token;
if (!PK) throw new Error('no publishable key');

// Idempotent: drop any previous run's pack first (also releases the
// single-active-free_welcome slot the admin validation enforces).
await fetch(`${API}/admin/packs/${SLUG}`, { method: 'DELETE', headers: AH });

const packBody = {
  slug: SLUG,
  title: 'QA Free Welcome Pack',
  category: 'free_welcome',
  price: 0, // enforced by admin validation — a free_welcome pack must be free
  image: '/images/polycards/bronze-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft', // activate only once the pool exists (activation guard)
};
await fetch(`${API}/admin/packs`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify(packBody),
}).then(json);

const cards = await fetch(`${API}/admin/cards?limit=2`, { headers: AH }).then(
  json,
);
const handles = (cards.cards ?? []).slice(0, 2).map((c) => c.handle);
if (handles.length === 0) throw new Error('no cards in the local catalog');
await fetch(`${API}/admin/packs/${SLUG}/members`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({ card_ids: handles }),
}).then(json);
await fetch(`${API}/admin/packs/${SLUG}/odds`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({
    entries: handles.map((h) => ({
      card_id: h,
      rarity: 'Common',
      locked: false,
      pct: 0,
    })),
  }),
}).then(json);
await fetch(`${API}/admin/packs/${SLUG}`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({ ...packBody, status: 'active' }),
}).then(json);
ok(`active free_welcome pack '${SLUG}' over ${handles.length} card(s)`);

// The catalog must NOT list it — the badge is its only entry point.
const catalog = await fetch(`${API}/store/packs`, {
  headers: { 'x-publishable-api-key': PK },
}).then(json);
if ((catalog.packs ?? []).some((p) => p.slug === SLUG)) {
  fail('free_welcome pack is listed in the public catalog');
} else {
  ok('free_welcome pack excluded from GET /store/packs');
}

// Brand-new customer — the subscriber stamps its one-time claim on create.
const email = `qa-free-${Date.now()}@test.dev`;
const reg = await fetch(`${API}/auth/customer/emailpass/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: PASSWORD }),
}).then(json);
await fetch(`${API}/store/customers`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': PK,
    Authorization: `Bearer ${reg.token}`,
  },
  body: JSON.stringify({ email }),
}).then(json);
ok(`registered ${email}`);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 }, // mobile-first: the badge docks above the tab bar
  });
  const page = await context.newPage();

  // Log in through the storefront so the httpOnly JWT cookie is set the real way.
  await page.goto(`${BASE}/slots`, { waitUntil: 'domcontentloaded' });
  // Answer the consent banner first: it docks on the same bottom rail as the
  // badge and the vault action bar, both of which stay hidden until it's gone.
  await page
    .getByRole('button', { name: /^reject$/i })
    .first()
    .click();
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page.waitForTimeout(2500);

  // 1 ── the badge is on /slots for an eligible account.
  // networkidle, not domcontentloaded: mid-stream React parks the incoming
  // subtree in a hidden holder, so a testid can transiently resolve to TWO
  // hidden nodes and trip strict mode.
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
  const badge = page.getByTestId('free-pack-badge').first();
  await badge.waitFor({ state: 'visible', timeout: 20000 });
  ok('free-pack badge visible on /slots');
  await shot(page, 'badge');

  // 1b ── BADGE vs CATALOG. The badge is `fixed` bottom-right at z-40, floating
  // OVER the catalog, so it gets TWO assertions — they fail on different bugs
  // and neither substitutes for the other:
  //
  //   (a) CLEARANCE. At the end of the scroll the badge must not sit on a
  //       catalog tile: CatalogClient reserves its rail as bottom padding
  //       (`pb-56 lg:pb-44`, gated on the badge rendering). Delete that padding
  //       and this fails — that is the regression this half exists to catch.
  //       Measured against tile boxes, since a tile's Open/MAX controls live at
  //       its bottom edge, exactly where the badge lands.
  //   (b) NO TAP SWALLOWING. Mid-scroll a row still passes under the badge —
  //       padding cannot change that, only the resting position. So park a tile
  //       under the badge on purpose and tap it with a NON-forced click, making
  //       Playwright's pointer-interception check the assertion. If no genuinely
  //       overlapping tile can be found the check has nothing to prove and FAILS
  //       rather than falling back to a tile that never touched the badge.
  //
  // 700px tall on desktop, not 900: at 900 this catalog fits without scrolling
  // and the badge floats over empty footer space, which would make the tap test
  // vacuous — a real (longer) catalog always has a card row on that rail.
  for (const [w, h, label] of [
    [375, 812, 'mobile'],
    [1440, 700, 'desktop'],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
    const floating = page.getByTestId('free-pack-badge').first();
    await floating.waitFor({ state: 'visible', timeout: 20000 });
    // Catalog links only: every pack href carries ?count=, the badge's does not.
    const tiles = page.locator('a[href*="count="]');
    const hits = (a, b) =>
      a.x < b.x + b.width &&
      b.x < a.x + a.width &&
      a.y < b.y + b.height &&
      b.y < a.y + a.height;
    // On-screen tiles + whether each intersects the badge, at the current scroll.
    const scan = async () => {
      const badgeBox = await floating.boundingBox();
      const rows = [];
      for (let i = 0; i < (await tiles.count()); i++) {
        const box = await tiles.nth(i).boundingBox();
        if (!box) continue;
        const onScreen =
          box.y + box.height > 0 &&
          box.y < h &&
          box.x + box.width > 0 &&
          box.x < w;
        if (!onScreen) continue;
        rows.push({ i, box, overlap: hits(box, badgeBox) });
      }
      return rows;
    };

    // (a) CLEARANCE at rest, bottom of the page. Measured as a GAP, not a
    // boolean: with the page's footer under the badge, "no intersection" is
    // true even with the padding deleted, so a boolean here would be vacuous.
    // Measured on this catalog, 2026-08-14 — padding deleted: desktop 6px
    // (fails), mobile 51px; padding present: desktop 166px, mobile 259px. The
    // gap is what the reserved rail actually buys, so the gap is asserted.
    await page.keyboard.press('End');
    await page.waitForTimeout(700);
    const badgeBox = await floating.boundingBox();
    const atRest = await scan();
    // Only tiles on the badge's own column can be fouled by it.
    const onRail = atRest.filter(
      (u) =>
        u.box.x < badgeBox.x + badgeBox.width &&
        badgeBox.x < u.box.x + u.box.width,
    );
    const gap = onRail.length
      ? Math.min(...onRail.map((u) => badgeBox.y - (u.box.y + u.box.height)))
      : Infinity;
    await shot(page, `badge-clearance-${label}`);
    if (gap >= MIN_BADGE_GAP) {
      ok(
        `${label}: badge sits ${Math.round(gap)}px below the nearest control at full scroll`,
      );
    } else {
      fail(
        `${label}: only ${Math.round(gap)}px between the badge and a catalog control at full scroll (want >= ${MIN_BADGE_GAP}px) — the reserved rail is gone`,
      );
    }

    // (b) NO TAP SWALLOWING — park a tile under the badge, then tap it.
    let nearest = null;
    let overlaps = false;
    for (let step = 0; step < 30 && !overlaps; step++) {
      const rows = await scan();
      nearest = rows.find((u) => u.overlap) ?? null;
      overlaps = Boolean(nearest);
      if (!overlaps) {
        await page.mouse.wheel(0, -90);
        await page.waitForTimeout(250);
      }
    }
    await shot(page, `badge-overlap-${label}`);
    if (!nearest) {
      fail(`${label}: no catalog tile parked under the badge`);
      continue;
    }
    const target = tiles.nth(nearest.i);
    const href = await target.getAttribute('href');
    try {
      await target.click({ timeout: 5000 });
      await page.waitForURL(
        new RegExp(href.split('?')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        { timeout: 15000 },
      );
      // `overlap:true` is what makes this a real test — false means the local
      // catalog was too short to park a tile under the badge at this viewport.
      ok(`${label}: tile ${href} opens on tap (badge overlap: ${overlaps})`);
    } catch (e) {
      fail(
        `${label}: badge swallowed the tap on ${href} — ${e.message.split('\n')[0]}`,
      );
    }
  }
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });

  // 2 ── the detail page is in free mode
  await badge.click();
  await page.waitForURL(new RegExp(`/slots/${SLUG}`), { timeout: 20000 });
  const openCta = page.getByRole('button', { name: /open free pack/i }).first();
  await openCta.waitFor({ timeout: 20000 });
  ok('detail CTA reads "Open Free Pack"');
  const dockText = await page.getByTestId('pack-buy-dock').first().innerText();
  if (/RM/.test(dockText)) fail(`free detail still shows a price: ${dockText}`);
  else ok('no price in the buy dock');
  if (await page.getByLabel('Increase quantity').first().isVisible()) {
    fail('quantity stepper is still visible on the free pack');
  } else {
    ok('no quantity stepper');
  }
  await shot(page, 'detail');

  // 2b ── free mode is a LAYOUT fork, so check both breakpoints against a paid
  // control. The desktop configurator (`lg:` only) carries its own CTA,
  // quantity row and footer copy — none of which the phone viewport renders, so
  // a mobile-only pass leaves the paid money page with zero coverage.
  for (const [slug, kind] of [
    [SLUG, 'free'],
    [PAID_SLUG, 'paid'],
  ]) {
    for (const [w, h, label] of [
      [430, 932, 'mobile'],
      [1440, 900, 'desktop'],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/slots/${slug}`, { waitUntil: 'networkidle' });
      const cta = page
        .getByRole('button', { name: /open (free )?pack/i })
        .filter({ visible: true })
        .first();
      if (!(await cta.count())) {
        fail(`${kind}/${label}: no open CTA on /slots/${slug}`);
        continue;
      }
      const ctaText = (await cta.innerText()).replace(/\s+/g, ' ').trim();
      const stepper = await page
        .getByLabel('Increase quantity')
        .filter({ visible: true })
        .count();
      const wantsFree = kind === 'free';
      const labelOk = wantsFree
        ? /open free pack/i.test(ctaText)
        : /open pack/i.test(ctaText) && !/free/i.test(ctaText);
      // The desktop CTA carries the total inside the pill; the phone dock holds
      // it instead, so only the desktop pill is a price assertion.
      const priceOk =
        label === 'mobile' ||
        (wantsFree ? !/RM/.test(ctaText) : /RM/.test(ctaText));
      const stepperOk = wantsFree ? stepper === 0 : stepper > 0;
      if (labelOk && priceOk && stepperOk) {
        ok(`${kind}/${label}: "${ctaText}", ${stepper} stepper(s)`);
      } else {
        fail(`${kind}/${label}: "${ctaText}", ${stepper} stepper(s)`);
      }
      await shot(page, `detail-${kind}-${label}`);
    }
  }
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'networkidle' });

  // 3 ── open it: the reveal offers no sell, only the unlock note
  await openCta.click();
  await page.waitForURL(/\/spin/, { timeout: 20000 });
  await page
    .getByRole('button', { name: /open free pack/i })
    .first()
    .click();
  const revealCard = page.getByText(/tap the card to reveal/i);
  await revealCard.waitFor({ timeout: 40000 });
  // force: the slab keeps a perpetual idle motion, so Playwright's
  // "element is stable" wait can never settle on it.
  await page
    .getByRole('button', { name: /flip to reveal your card/i })
    .first()
    .click({ force: true });
  const note = page.getByText(
    /purchase & open any pack to unlock selling & delivery\./i,
  );
  await note.waitFor({ timeout: 20000 });
  ok('reveal shows the verbatim unlock note');
  if (await page.getByRole('button', { name: /^sell for/i }).count()) {
    fail('reveal still offers a Sell button on a free pull');
  } else {
    ok('reveal has no Sell button');
  }
  await shot(page, 'reveal');
  await page.getByRole('button', { name: /keep in vault/i }).click();
  await page.waitForTimeout(2500);

  // 4 ── the vault shows the locked overlay and refuses selection
  await page.goto(`${BASE}/vault`, { waitUntil: 'networkidle' });
  const overlay = page.getByText(/shipping & selling locked/i).first();
  await overlay.waitFor({ timeout: 20000 });
  ok('vault renders the locked overlay');
  await shot(page, 'vault-locked');
  await overlay.click(); // tap to dismiss
  await page.waitForTimeout(500);
  if (await page.getByText(/shipping & selling locked/i).count()) {
    fail('locked overlay did not dismiss on tap');
  } else {
    ok('overlay dismisses on tap');
  }
  // The card is not selectable, so Sell/Deliver stay disabled. force: the tile
  // carries aria-disabled (Playwright reads that as "not enabled"), which IS
  // the assertion — a real tap still reaches it and re-shows the explainer.
  await page
    .getByRole('button', { name: /shipping & selling locked/i })
    .first()
    .click({ force: true });
  await page.waitForTimeout(400);
  if (await page.getByText(/shipping & selling locked/i).count()) {
    ok('tapping a locked card re-shows the explainer');
  } else {
    fail('locked card tap did not re-show the explainer');
  }
  const sellPill = page.getByRole('button', { name: /^sell$/i }).first();
  if (await sellPill.isDisabled())
    ok('Sell stays disabled — locked card cannot be selected');
  else fail('Sell enabled with only a locked card in the vault');
  // Select All must never re-add the locked row behind the per-row guard. With
  // ONLY a locked card in the vault the selectable set is empty, so the control
  // is disabled outright; with other cards present it is pressable and simply
  // skips the locked one — both leave Sell disabled here.
  const selectAll = page.getByRole('button', { name: /select all/i });
  if (await selectAll.isDisabled()) {
    ok('Select All disabled — the locked card is not a selectable row');
  } else {
    await selectAll.click();
    await page.waitForTimeout(400);
    if (await sellPill.isDisabled())
      ok('Select All does not pick up the locked card');
    else fail('Select All re-armed Sell on a locked card');
  }
  await shot(page, 'vault-selection');

  // 5 ── the badge is gone once the claim is spent
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (await page.getByTestId('free-pack-badge').count()) {
    fail('badge still visible after the claim was spent');
  } else {
    ok('badge gone after claim');
  }
  await shot(page, 'badge-gone');
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
  // Hand back the single-active-`free_welcome` slot. Left active, this QA pack
  // blocks the next activation of ANY free pack (the admin validation allows
  // exactly one) — including the next run of this script and the local seed
  // fixture. Draft, not DELETE: the run's pulls still reference it.
  const teardown = await fetch(`${API}/admin/packs/${SLUG}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ ...packBody, status: 'draft' }),
  });
  if (teardown.ok) ok(`'${SLUG}' set back to draft (slot released)`);
  else fail(`teardown: '${SLUG}' is still active — ${teardown.status}`);
}
