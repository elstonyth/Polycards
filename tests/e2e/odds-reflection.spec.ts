// THE headline: an admin win-rate adjustment must take effect on the real
// storefront pull, even though the storefront's *displayed* Pull Odds are the
// admin-PUBLISHED rates (pack.published_odds — a display-only setting) that are
// decoupled from the secret per-card weights by design.
//
// Proof (per the operator's spec): set ONE card to 100% win rate, open the pack
// a few times — every pull must be that same card. Repeat on a DIFFERENT pack
// with a DIFFERENT card so it's not a one-pack fluke. Pack A is adjusted through
// the admin UI; pack B through the odds API (the same mutation the UI performs).
// Throughout, assert the published Pull Odds panel never moves.
//
// Re-authored 2026-07-12 against the /slots storefront (plan 023): the old
// hardcoded-ODDS <li> assertion is gone — the panel now renders the backend's
// published_odds, so the invariant is checked as a before/after snapshot of the
// panel itself (win-rate writes must never leak into the published display).
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import {
  adminToken,
  createCustomer,
  getOdds,
  setOdds,
  snapshotOdds,
  openPack,
  type CustomerCreds,
  type OddsRow,
} from './helpers/api';
import { ensureAdmin, forceCardTo100ViaUI } from './helpers/admin';
import { fundFor, mutationPacks, type TestPack } from './helpers/catalog';

const OPENS = 3;

let admin: string;
let customer: CustomerCreds;
// Two REAL packs, resolved from the live catalog so this spec follows a price
// change instead of breaking on one. NOT the pack the rest of the suite opens:
// this spec rewrites win rates, and a crash before its `finally` restore would
// otherwise leave every later spec opening a rigged pack.
let packA: TestPack;
let packB: TestPack;

test.beforeAll(async () => {
  admin = await adminToken();
  [packA, packB] = await mutationPacks();
  // Enough for OPENS opens of BOTH packs, derived from their live prices.
  customer = await createCustomer(
    fundFor(packA, OPENS) + fundFor(packB, OPENS),
  );
});

// Pick a drawable target: in the pool, with stock for OPENS opens (highest stock).
function pickTarget(odds: OddsRow[]): OddsRow {
  const drawable = odds
    .filter((o) => o.stock === null || o.stock >= OPENS)
    .sort((a, b) => (b.stock ?? 1e9) - (a.stock ?? 1e9));
  const target = drawable[0];
  if (!target) throw new Error('no card with enough stock');
  return target;
}

// Snapshot the player-facing Pull Odds panel on /slots/<slug> (the admin-
// published rates), or its absence when the pack has none published. Comparing
// before/after proves a win-rate adjustment never moves the published display.
async function publishedOddsSnapshot(
  page: import('@playwright/test').Page,
  slug: string,
): Promise<string> {
  await page.goto(`${BASE}/slots/${slug}`, { waitUntil: 'domcontentloaded' });
  // `Reveal as="section"` nests inside an outer <section>, so BOTH ancestors
  // match `hasText` and the SAME list resolves twice — strict mode then throws
  // before the panel is ever read. Narrow to the INNERMOST match (`.last()`,
  // which is the Reveal wrapper) rather than `.first()` on the lists: that one
  // section holds exactly one <ul> (PublishedOddsList renders a single list),
  // so strict mode still catches a genuinely duplicated panel.
  const panel = page
    .locator('section', { hasText: 'Pull Odds (by rarity)' })
    .last()
    .locator('ul');
  if ((await panel.count()) === 0) return 'no published odds panel';
  return (await panel.innerText()).trim();
}

async function assertEveryPullIs(
  token: string,
  slug: string,
  expectedName: string,
): Promise<void> {
  const pulled: string[] = [];
  for (let i = 0; i < OPENS; i++) {
    const res = await openPack(token, slug);
    pulled.push(res.card.name);
  }
  // Every single open returned the forced card.
  expect(pulled).toEqual(Array(OPENS).fill(expectedName));
}

test('pack A (entry pack): 100% via admin UI → every pull is that card', async ({
  page,
}) => {
  const slug = packA.slug;
  const original = snapshotOdds((await getOdds(admin, slug)).odds);
  const publishedBefore = await publishedOddsSnapshot(page, slug);
  try {
    const target = pickTarget((await getOdds(admin, slug)).odds);

    // Adjust through the admin dashboard UI (session from storageState).
    await ensureAdmin(page);
    await forceCardTo100ViaUI(page, slug, target.name);

    // Backend confirms the target is now pinned at 100%.
    const after = (await getOdds(admin, slug)).odds.find(
      (o) => o.card_id === target.card_id,
    );
    expect(after?.pct).toBe(100);

    // The published Pull Odds display did NOT move.
    expect(await publishedOddsSnapshot(page, slug)).toBe(publishedBefore);

    // The REAL pull behavior did: every open returns the forced card.
    await assertEveryPullIs(customer.token, slug, target.name);
  } finally {
    await setOdds(admin, slug, original); // restore operator odds
  }
});

test('pack B (second pack): 100% via odds API → every pull is that card', async ({
  page,
}) => {
  const slug = packB.slug;
  const before = (await getOdds(admin, slug)).odds;
  const original = snapshotOdds(before);
  const publishedBefore = await publishedOddsSnapshot(page, slug);
  try {
    const target = pickTarget(before);

    // Same mutation the UI does, applied through the odds API: target locked at
    // 100, everyone else unlocked (their computed share collapses to 0).
    await setOdds(
      admin,
      slug,
      before.map((o) => ({
        card_id: o.card_id,
        rarity: o.rarity,
        locked: o.card_id === target.card_id,
        pct: o.card_id === target.card_id ? 100 : 0,
      })),
    );
    const after = (await getOdds(admin, slug)).odds.find(
      (o) => o.card_id === target.card_id,
    );
    expect(after?.pct).toBe(100);

    expect(await publishedOddsSnapshot(page, slug)).toBe(publishedBefore);
    await assertEveryPullIs(customer.token, slug, target.name);
  } finally {
    await setOdds(admin, slug, original);
  }
});
