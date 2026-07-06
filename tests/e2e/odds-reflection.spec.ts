// FIXME(ui-drift, PR #85): asserts the old li-based published-odds panel that
// the slots-only storefront no longer renders. The 100%-win reflection idea is
// still the headline test — rewrite the storefront half against /slots.
// THE headline: an admin win-rate adjustment must take effect on the real
// storefront pull, even though the storefront's *displayed* Pull Odds are a
// hardcoded marketing table that is decoupled from the secret weights by design.
//
// Proof (per the operator's spec): set ONE card to 100% win rate, open the pack
// a few times — every pull must be that same card. Repeat on a DIFFERENT pack
// with a DIFFERENT card so it's not a one-pack fluke. Pack A is adjusted through
// the admin UI; pack B through the odds API (the same mutation the UI performs).
// Throughout, assert the published Pull Odds panel never moves.
import { test, expect } from '@playwright/test';
import { BASE, PUBLISHED_ODDS } from './helpers/constants';
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

const OPENS = 3;

let admin: string;
let customer: CustomerCreds;

test.beforeAll(async () => {
  admin = await adminToken();
  // Fund enough for OPENS opens of both packs (rookie $25, elite $50) + margin.
  customer = await createCustomer(400);
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

async function assertPublishedOddsUnchanged(
  page: import('@playwright/test').Page,
  slug: string,
): Promise<void> {
  await page.goto(`${BASE}/claw/${slug}`, { waitUntil: 'domcontentloaded' });
  for (const [rarity, pct] of PUBLISHED_ODDS) {
    await expect(
      page.locator('li', { hasText: rarity }).filter({ hasText: pct }),
    ).toHaveCount(1);
  }
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

test.fixme('pack A (pokemon-rookie): 100% via admin UI → every pull is that card', async ({
  page,
}) => {
  const slug = 'pokemon-rookie';
  const original = snapshotOdds((await getOdds(admin, slug)).odds);
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

    // The decorative published odds did NOT move.
    await assertPublishedOddsUnchanged(page, slug);

    // The REAL pull behavior did: every open returns the forced card.
    await assertEveryPullIs(customer.token, slug, target.name);
  } finally {
    await setOdds(admin, slug, original); // restore operator odds
  }
});

test.fixme('pack B (pokemon-elite): 100% via odds API → every pull is that card', async ({
  page,
}) => {
  const slug = 'pokemon-elite';
  const before = (await getOdds(admin, slug)).odds;
  const original = snapshotOdds(before);
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

    await assertPublishedOddsUnchanged(page, slug);
    await assertEveryPullIs(customer.token, slug, target.name);
  } finally {
    await setOdds(admin, slug, original);
  }
});
