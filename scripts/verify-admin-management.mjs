// Full management-surface probe against the live backend (:9000): admin reads,
// the complete pack lifecycle (create draft -> edit -> members -> odds ->
// delete), the complete card lifecycle on a THROWAWAY product (create product
// -> register card -> edit -> unregister -> delete product), public endpoints
// (leaderboard, profile, recent pulls), and the PriceCharting proxy fallback.
// Everything is created with qa-mgmt-* names and removed in `finally`.
// Run: node scripts/verify-admin-management.mjs
const BACKEND = 'http://localhost:9000';
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const ADMIN_EMAIL = 'qa-admin@pokenic.local';
const ADMIN_PASSWORD = 'QaAdmin2026!';
const STAMP = Date.now();
const PACK_SLUG = `qa-mgmt-pack-${STAMP}`;

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const { token: adminToken } = await (
  await fetch(`${BACKEND}/auth/user/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
).json();

const req = async (path, opts = {}, expect = 200) => {
  const res = await fetch(`${BACKEND}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      Authorization: `Bearer ${adminToken}`,
      ...(opts.headers ?? {}),
    },
  });
  if (expect !== null && res.status !== expect) {
    throw new Error(
      `${path} -> ${res.status} (wanted ${expect}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res.status === 204 ? null : res.json().catch(() => null);
};

let productId = null;
let cardHandle = null;
let packCreated = false;

try {
  // ── admin reads ─────────────────────────────────────────────────────────
  const cards = await req('/admin/cards');
  ok(
    `GET /admin/cards: ${cards.cards.length} cards (stock field: ${'stock' in cards.cards[0] ? 'present' : 'MISSING'})`,
  );
  const packs = await req('/admin/packs');
  ok(`GET /admin/packs: ${packs.packs.length} packs`);
  const pulls = await req('/admin/pulls');
  ok(
    `GET /admin/pulls: ${pulls.total} total pulls, top-card rollup ${pulls.topCards.length} rows, rarity rollup ${pulls.topRarities.length} rows`,
  );

  // ── pack lifecycle ──────────────────────────────────────────────────────
  await req(
    '/admin/packs',
    {
      method: 'POST',
      body: JSON.stringify({
        slug: PACK_SLUG,
        title: 'QA Mgmt Pack',
        category: 'pokemon',
        price: 10,
        image: '/images/claw/trainer-pack-icon.webp',
        status: 'draft',
      }),
    },
    201,
  );
  packCreated = true;
  ok('pack created (draft)');

  const created = await req(`/admin/packs/${PACK_SLUG}`);
  if (created.pack.title === 'QA Mgmt Pack') ok('pack readable after create');

  await req(`/admin/packs/${PACK_SLUG}`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'QA Mgmt Pack EDITED',
      category: 'pokemon',
      price: 15,
      image: '/images/claw/trainer-pack-icon.webp',
      status: 'draft',
    }),
  });
  const edited = await req(`/admin/packs/${PACK_SLUG}`);
  if (
    edited.pack.title === 'QA Mgmt Pack EDITED' &&
    Number(edited.pack.price) === 15
  )
    ok('pack update applied (title + price)');
  else
    fail(`pack update mismatch: ${edited.pack.title} / ${edited.pack.price}`);

  // draft must NOT appear on the public storefront list
  const store = await req('/store/packs', { headers: { Authorization: '' } });
  if (!store.packs.some((p) => p.slug === PACK_SLUG))
    ok('draft pack hidden from public /store/packs');
  else fail('draft pack LEAKED to the public catalog');

  // membership: assign 2 existing cards to the pool
  const twoCards = cards.cards.slice(0, 2).map((c) => c.handle);
  await req(`/admin/packs/${PACK_SLUG}/members`, {
    method: 'POST',
    body: JSON.stringify({ card_ids: twoCards }),
  });
  const odds = await req(`/admin/packs/${PACK_SLUG}/odds`);
  const sumPct = odds.odds.reduce((s, o) => s + o.pct, 0);
  if (odds.odds.length === 2 && Math.round(sumPct) === 100)
    ok(`members set (2 cards), odds auto-normalized to ${sumPct.toFixed(2)}%`);
  else fail(`odds after members: ${odds.odds.length} rows, sum ${sumPct}`);

  // odds saves require an ACTIVE pack (save-pack-odds.ts filters
  // status:"active" — drafts 404 by design), so activate first and confirm
  // the status flip also makes the pack publicly visible.
  await req(`/admin/packs/${PACK_SLUG}`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'QA Mgmt Pack EDITED',
      category: 'pokemon',
      price: 15,
      image: '/images/claw/trainer-pack-icon.webp',
      status: 'active',
    }),
  });
  const storeAfter = await req('/store/packs', {
    headers: { Authorization: '' },
  });
  if (storeAfter.packs.some((p) => p.slug === PACK_SLUG))
    ok('activated pack now visible on public /store/packs');
  else fail('activated pack still hidden from the public catalog');

  // odds editor: lock one card at 60%
  await req(`/admin/packs/${PACK_SLUG}/odds`, {
    method: 'POST',
    body: JSON.stringify({
      entries: odds.odds.map((o, i) => ({
        card_id: o.card_id,
        rarity: o.rarity,
        locked: i === 0,
        pct: i === 0 ? 60 : 0,
      })),
    }),
  });
  const lockedState = await req(`/admin/packs/${PACK_SLUG}/odds`);
  const first = lockedState.odds.find((o) => o.locked);
  if (first && first.pct === 60) ok('odds save: locked card holds exactly 60%');
  else fail(`locked card pct: ${first?.pct}`);

  // ── card lifecycle on a throwaway product ──────────────────────────────
  const prod = await req(
    '/admin/products',
    {
      method: 'POST',
      body: JSON.stringify({
        title: `QA Mgmt Card ${STAMP}`,
        status: 'published',
        thumbnail: '/images/claw/trainer-pack-icon.webp',
        images: [{ url: '/images/claw/trainer-pack-icon.webp' }],
        options: [{ title: 'Default', values: ['Default'] }],
        variants: [
          {
            title: 'Default',
            options: { Default: 'Default' },
            prices: [{ amount: 10, currency_code: 'usd' }],
          },
        ],
      }),
    },
    null,
  );
  productId = prod?.product?.id ?? null;
  cardHandle = prod?.product?.handle ?? null;
  if (!productId) throw new Error('throwaway product create failed');
  ok(`throwaway product created (${cardHandle})`);

  const eligible = await req('/admin/gacha/eligible-products');
  if (eligible.products.some((p) => p.id === productId))
    ok('new product listed in gacha eligible-products');
  else fail('new product missing from eligible-products');

  await req(
    '/admin/cards',
    {
      method: 'POST',
      body: JSON.stringify({
        product_id: productId,
        set: 'QA Set',
        grader: 'PSA',
        grade: '10',
        market_value: 12.34,
      }),
    },
    201,
  );
  ok('card registered from inventory');

  const cardRead = await req(`/admin/cards/${cardHandle}`);
  if (Number(cardRead.card.market_value) === 12.34)
    ok('card readable with correct FMV (12.34)');

  await req(`/admin/cards/${cardHandle}`, {
    method: 'POST',
    body: JSON.stringify({
      name: `QA Mgmt Card ${STAMP}`,
      set: 'QA Set',
      grader: 'CGC',
      grade: '9.5',
      market_value: 55.5,
      image: '/images/claw/trainer-pack-icon.webp',
      for_sale: false,
    }),
  });
  const cardEdited = await req(`/admin/cards/${cardHandle}`);
  if (
    Number(cardEdited.card.market_value) === 55.5 &&
    cardEdited.card.grader === 'CGC'
  )
    ok('card update applied (FMV 55.5, grader CGC)');
  else
    fail(
      `card update mismatch: ${cardEdited.card.market_value} / ${cardEdited.card.grader}`,
    );

  await req(`/admin/cards/${cardHandle}`, { method: 'DELETE' });
  cardHandle = null;
  const afterDelete = await req('/admin/gacha/eligible-products');
  if (afterDelete.products.some((p) => p.id === productId))
    ok('card unregistered — product KEPT and eligible again');
  else fail('after unregister: product not back in eligible list');

  // ── public endpoints ─────────────────────────────────────────────────────
  const lbW = await req('/store/leaderboard?period=weekly', {
    headers: { Authorization: '' },
  });
  const lbA = await req('/store/leaderboard?period=alltime', {
    headers: { Authorization: '' },
  });
  ok(
    `leaderboard: weekly ${lbW.entries.length} entries, alltime ${lbA.entries.length} entries`,
  );
  if (!JSON.stringify(lbA).includes('@')) ok('leaderboard leaks no emails');
  else fail('leaderboard contains an @ (email leak?)');

  const prof = await req('/store/profiles/kenji-ejxy', {
    headers: { Authorization: '' },
  });
  // response is flat: { handle, name, seed, stats, recent } — no wrapper
  if (prof.handle === 'kenji-ejxy' && prof.stats && Array.isArray(prof.recent))
    ok(
      `public profile resolves (kenji-ejxy: ${prof.stats.pulls} pulls, ${prof.recent.length} recent)`,
    );
  else fail('public profile kenji-ejxy failed');

  const recent = await req('/store/pulls/recent', {
    headers: { Authorization: '' },
  });
  if (
    Array.isArray(recent.pulls) &&
    !JSON.stringify(recent).includes('customer_id')
  )
    ok(
      `recent pulls feed: ${recent.pulls.length} entries, no customer_id exposed`,
    );
  else fail('recent pulls feed missing or leaks customer_id');

  // ── PriceCharting proxy (no token configured -> graceful 503) ───────────
  const pc = await fetch(`${BACKEND}/admin/pricecharting/search?q=pikachu`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (pc.status === 503)
    ok(
      'PriceCharting proxy: graceful 503 without a token (manual-entry fallback)',
    );
  else if (pc.ok) ok('PriceCharting proxy: live (token configured)');
  else fail(`PriceCharting proxy unexpected status ${pc.status}`);
} finally {
  // cleanup, tolerant of partial progress
  try {
    if (cardHandle)
      await req(`/admin/cards/${cardHandle}`, { method: 'DELETE' }, null);
    if (productId)
      await req(`/admin/products/${productId}`, { method: 'DELETE' }, null);
    if (packCreated)
      await req(`/admin/packs/${PACK_SLUG}`, { method: 'DELETE' }, null);
    ok('cleanup done (throwaway pack/card/product removed)');
  } catch (e) {
    fail(`cleanup issue: ${e.message}`);
  }
}
