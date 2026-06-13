// One-off proof that admin win-rate edits drive the REAL roll while the
// storefront's published odds stay static:
//   1. lock one card at 100% via the admin odds API (others drop to weight 0)
//   2. open 5 real packs as a funded customer -> every pull must be that card
//   3. while locked: GET /store/packs/:slug carries NO weight field, and the
//      rendered :4000 page still shows the static 0.5/4.5/15/30/50 odds
//   4. restore the operator's original odds
// Run: node scripts/verify-winrate-applies.mjs
const BACKEND = 'http://localhost:9000';
const STORE = 'http://localhost:4000';
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const PACK = 'pokemon-rookie';
const ADMIN_EMAIL = 'qa-admin@pokenic.local';
const ADMIN_PASSWORD = 'QaAdmin2026!';
const OPENS = 5;

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const api = async (path, opts = {}) => {
  const res = await fetch(`${BACKEND}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── admin: lock the cheapest card at 100% ───────────────────────────────────
const { token: adminToken } = await api('/auth/user/emailpass', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminHeaders = { Authorization: `Bearer ${adminToken}` };
const state = await api(`/admin/packs/${PACK}/odds`, { headers: adminHeaders });
const original = state.odds.map((o) => ({
  card_id: o.card_id,
  locked: o.locked,
  pct: o.pct,
  rarity: o.rarity,
}));
const values = state.odds.map((o) => Number(o.market_value) || 0);
const targetIdx = values.indexOf(Math.min(...values));
const target = state.odds[targetIdx].card_id;
ok(
  `target card: ${target} (cheapest, normally ~${state.odds[targetIdx].pct}%)`,
);

let restored = false;
const restore = async () => {
  if (restored) return;
  await api(`/admin/packs/${PACK}/odds`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ entries: original }),
  });
  restored = true;
  ok('original odds restored');
};

try {
  await api(`/admin/packs/${PACK}/odds`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      entries: original.map((o, i) =>
        i === targetIdx
          ? { ...o, locked: true, pct: 100 }
          : { ...o, locked: false },
      ),
    }),
  });
  ok(`admin locked ${target} at 100% win rate`);

  // sanity: editor confirms 100/0 split
  const after = await api(`/admin/packs/${PACK}/odds`, {
    headers: adminHeaders,
  });
  const tpct = after.odds.find((o) => o.card_id === target)?.pct;
  if (tpct === 100) ok('odds editor confirms target at 100.00%');
  else fail(`editor shows target at ${tpct}%`);

  // ── while locked: storefront leaks nothing ────────────────────────────────
  const pub = await api(`/store/packs/${PACK}`);
  const raw = JSON.stringify(pub);
  if (!raw.includes('"weight"'))
    ok('public pack endpoint carries NO weight field');
  else fail('public pack endpoint LEAKS weight');
  const html = await (await fetch(`${STORE}/claw/${PACK}`)).text();
  const staticShown = ['0.5%', '4.5%', '15%', '30%', '50%'].every((p) =>
    html.includes(p),
  );
  if (staticShown)
    ok('storefront page still shows the static 0.5/4.5/15/30/50 odds');
  else fail('storefront odds display changed after the admin edit');

  // ── funded customer opens 5 packs ─────────────────────────────────────────
  const email = `winrate-${Date.now()}@pokenic.local`;
  const password = 'Winrate2026!';
  const reg = await api('/auth/customer/emailpass/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  await api('/store/customers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ email }),
  });
  const { token } = await api('/auth/customer/emailpass', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  await api('/store/credits/topup', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      amount: 150,
      card: { number: '4242424242424242', exp: '12/30', cvc: '123' },
    }),
  });
  ok(`fresh customer funded $150 (${email})`);

  const wins = [];
  for (let i = 0; i < OPENS; i++) {
    const res = await api(`/store/packs/${PACK}/open`, {
      method: 'POST',
      headers: auth,
    });
    wins.push(res.card.handle);
    await sleep(2500); // stay under the 5/10s open burst limit
  }
  console.log(`  pulls: ${wins.join(', ')}`);
  if (wins.every((w) => w === target))
    ok(
      `ALL ${OPENS}/${OPENS} real opens rolled the 100%-locked card — admin win rates DRIVE the roll`,
    );
  else
    fail(
      `${wins.filter((w) => w === target).length}/${OPENS} opens hit the locked card`,
    );
} finally {
  await restore();
}

// confirm the restore took
const back = await api(`/admin/packs/${PACK}/odds`, { headers: adminHeaders });
const samePcts = back.odds.every(
  (o) => original.find((x) => x.card_id === o.card_id)?.pct === o.pct,
);
if (samePcts) ok('editor re-check: per-card percentages match the originals');
else fail('restored percentages drifted from the originals');
