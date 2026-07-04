// Step 8 verification: prove locked win rates drive real draws.
// Creates a throwaway pack, locks one card at 95% via the hidden manual seam,
// opens it 10× as the test customer, reports the distribution, cleans up.

// Admin credentials come from env (repo rule: no hardcoded secrets) — the
// same dev login the e2e suite uses. e.g.:
//   QA_ADMIN_EMAIL=... QA_ADMIN_PASSWORD=... node scripts/<this>.mjs
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD (dev admin login).');
  process.exit(1);
}
const BASE = 'http://localhost:9000';
const SLUG = 'qa-lockcheck';
const OPENS = 10;
const LOCK_PCT = 95;

const admin = await fetch(`${BASE}/auth/user/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  }),
}).then((r) => r.json());
if (!admin.token) throw new Error('admin auth failed — check QA_ADMIN_* env');
const AH = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${admin.token}`,
};

// Publishable key for store routes.
const keys = await fetch(`${BASE}/admin/api-keys?type=publishable`, {
  headers: AH,
}).then((r) => r.json());
const pub = keys.api_keys?.[0]?.token;
if (!pub) throw new Error('no publishable key');

// 0. Clean slate (idempotent re-runs).
await fetch(`${BASE}/admin/packs/${SLUG}`, { method: 'DELETE', headers: AH });

// 1. Throwaway pack (draft; RM 1 per open).
const created = await fetch(`${BASE}/admin/packs`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({
    slug: SLUG,
    title: 'QA Lock Check',
    category: 'pokemon',
    price: 1,
    image: '/images/claw/rookie-pack-icon.webp',
    buyback_percent: 90,
    boost: false,
    rank: 99,
    status: 'draft',
  }),
});
console.log('create pack:', created.status);

// 2. Four member cards from the existing catalog.
const cards = await fetch(`${BASE}/admin/cards`, { headers: AH }).then((r) =>
  r.json(),
);
const handles = cards.cards.slice(0, 4).map((c) => c.handle);
const target = handles[0];
console.log('members:', handles.join(', '), '| locked target:', target);
const mem = await fetch(`${BASE}/admin/packs/${SLUG}/members`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({ card_ids: handles }),
});
console.log('set members:', mem.status);

// 3. Lock the target at 95% via the hidden manual seam.
const lock = await fetch(`${BASE}/admin/packs/${SLUG}/odds`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({
    entries: handles.map((h) => ({
      card_id: h,
      rarity: 'Common',
      locked: h === target,
      pct: h === target ? LOCK_PCT : 0,
    })),
  }),
});
console.log('lock save:', lock.status);

// 4. Activate.
const act = await fetch(`${BASE}/admin/packs/${SLUG}`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({
    title: 'QA Lock Check',
    category: 'pokemon',
    price: 1,
    image: '/images/claw/rookie-pack-icon.webp',
    buyback_percent: 90,
    boost: false,
    rank: 99,
    status: 'active',
  }),
});
console.log('activate:', act.status);

// 5. Test customer auth + credit top-up via admin adjust (RM 20 covers 10 × RM1).
const cust = await fetch(`${BASE}/auth/customer/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'test@pokenic.app',
    password: 'PokenicTest123!',
  }),
}).then((r) => r.json());
if (!cust.token) throw new Error('customer auth failed');
const CH = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${cust.token}`,
  'x-publishable-api-key': pub,
};
const me = await fetch(`${BASE}/store/customers/me`, { headers: CH }).then(
  (r) => r.json(),
);
const custId = me.customer?.id;
const credit = await fetch(`${BASE}/admin/customers/${custId}/credits`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({ amount: 20, note: 'QA locked-wins verification' }),
});
console.log('credit top-up:', credit.status);

// 6. Open ×10 (paced; retry on 429 — opens are rate-limited).
const tally = new Map();
for (let i = 0; i < OPENS; i++) {
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${BASE}/store/packs/${SLUG}/open`, {
      method: 'POST',
      headers: CH,
      body: '{}',
    });
    if (res.status === 429 && attempt < 6) {
      attempt++;
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!res.ok) throw new Error(`open ${i + 1} failed: ${res.status}`);
    const j = await res.json();
    const h = j.card.handle;
    tally.set(h, (tally.get(h) ?? 0) + 1);
    console.log(
      `open ${i + 1}/${OPENS}: ${h}${h === target ? '  <-- locked card' : ''}`,
    );
    break;
  }
  await new Promise((r) => setTimeout(r, 1200));
}

// 7. Distribution.
console.log('---');
for (const [h, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(
    `${h}: ${n}/${OPENS}${h === target ? `  (locked at ${LOCK_PCT}%)` : ''}`,
  );
}
const hitRate = ((tally.get(target) ?? 0) / OPENS) * 100;
console.log(`locked-card hit rate: ${hitRate}% (configured ${LOCK_PCT}%)`);

// 8. Cleanup: delete the QA pack (pulls stay in the ledger by design).
const del = await fetch(`${BASE}/admin/packs/${SLUG}`, {
  method: 'DELETE',
  headers: AH,
});
console.log('cleanup delete:', del.status);
