// Stress test: one pack with N (default 2001) card members.
//
// Seeds N synthetic, Product-less Card rows (tagged `qa-stress-*`), builds one
// throwaway pack `qa-stress-pack`, and probes the surfaces a big pool exercises:
//   - N=1 smoke: one tagged card opens/rolls/resolves before scaling (advisor #3)
//   - initial population to N members (empty pack → all added cleanly)
//   - a SECOND set-members call on the now-N pool — the regression probe: the
//     reconcile once read existing with take:1000, so a row past the cap looked
//     "missing" and got re-added, silently doubling that card's weight. With the
//     paged reconcile the pool must stay exactly N with no duplicates.
//   - a raw duplicate INSERT must be rejected by UQ_pack_odds_pack_card (backstop)
//   - odds fold timing, pack-detail store route, admin editor read (all paged)
//   - a handful of real opens against the fat pool (roll reads the whole pool)
//
// Teardown is TAG-BASED and idempotent (advisor #2): every synthetic row is
// `qa-stress-*`, so `--cleanup` removes them with one predicate even if a prior
// run crashed. Run `--cleanup` alone to wipe leftovers. Scale via STRESS_N.
//
//   QA_ADMIN_EMAIL=… QA_ADMIN_PASSWORD=… QA_ADMIN_TOTP_SECRET=… [STRESS_N=5000] node scripts/qa-pack-1000-stress.mjs [--cleanup]
//
// DB writes: synthetic Card rows are inserted straight into `card` (the admin
// POST only registers existing Medusa products; seeding 1001 products is
// infeasible). Cards need no Product for gacha open/roll/buyback (Phase 5a —
// Card carries its own display fields). Everything is tagged for teardown.
import { spawnSync } from 'node:child_process';
import { adminToken, requireAdminTotp } from './lib/admin-sign-in.mjs';

const BASE = 'http://localhost:9000';
const N = Number(process.env.STRESS_N ?? 2001);
const TAG = 'qa-stress';
const PACK = 'qa-stress-pack';
const CLEANUP_ONLY = process.argv.includes('--cleanup');

// SQL travels via STDIN, not `-c`: a 1000-row INSERT is ~130KB and blows past
// the Windows CreateProcess command-line arg limit (~32KB) — docker exec then
// fails before psql even runs (empty stderr). Piping to psql's stdin has no
// such ceiling.
const psql = (sql) => {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'pokenic-postgres',
      'psql',
      '-U',
      'medusa',
      '-d',
      'medusa',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { encoding: 'utf8', input: sql, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0)
    throw new Error(
      `psql failed: ${(r.stderr || r.stdout || '').trim() || 'no output'}`,
    );
  return r.stdout.trim();
};

// ---- teardown (also the --cleanup entrypoint) ----
function teardown() {
  // Separate statements so command tags never pollute the count we parse.
  psql(`DELETE FROM pack_odds WHERE pack_id='${PACK}';`);
  psql(`DELETE FROM pack_odds WHERE card_id LIKE '${TAG}-%';`);
  const cardsGone = psql(
    `WITH d AS (DELETE FROM card WHERE handle LIKE '${TAG}-%' RETURNING 1) SELECT count(*) FROM d;`,
  );
  psql(`DELETE FROM pack WHERE slug='${PACK}';`);
  console.log(
    `teardown: removed ${cardsGone} synthetic cards + pack '${PACK}' + its odds rows`,
  );
}

if (CLEANUP_ONLY) {
  teardown();
  console.log('cleanup done.');
  process.exit(0);
}

requireAdminTotp(process.env.QA_ADMIN_EMAIL);
const AH = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${await adminToken(BASE, process.env.QA_ADMIN_EMAIL, process.env.QA_ADMIN_PASSWORD)}`,
};
const keys = await fetch(`${BASE}/admin/api-keys?type=publishable`, {
  headers: AH,
}).then((r) => r.json());
const pub = keys.api_keys?.[0]?.token;
if (!pub) throw new Error('no publishable key');

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
};
const time = async (label, fn) => {
  const t0 = Date.now();
  const out = await fn();
  console.log(`  [${label}] ${Date.now() - t0}ms`);
  return out;
};

try {
  // Start from a clean slate (idempotent re-runs).
  teardown();

  // ---- seed N synthetic cards via one bulk INSERT ----
  await time(`seed ${N} cards`, async () => {
    const rows = [];
    for (let i = 0; i < N; i++) {
      const h = `${TAG}-${i}`;
      const val = `${(i % 500) + 1}.50`; // spread so buyback amounts vary
      // Medusa BigNumber columns need BOTH the numeric (market_value) and the
      // raw jsonb (raw_market_value — NOT NULL, no default). for_sale=false so
      // no marketplace Product is expected. market_multiplier + its raw use the
      // table defaults (1.2).
      rows.push(
        `('card_${TAG}_${i}','${h}','Stress ${i}','QA Set','PSA','10',${val},'{"value":"${val}","precision":20}','/images/claw/rookie-pack-icon.webp',false)`,
      );
    }
    psql(
      `INSERT INTO card (id, handle, name, "set", grader, grade, market_value, raw_market_value, image, for_sale)
       VALUES ${rows.join(',')};`,
    );
  });
  const seeded = Number(
    psql(`SELECT count(*) FROM card WHERE handle LIKE '${TAG}-%';`),
  );
  check(seeded === N, `seeded ${seeded}/${N} synthetic cards`);

  // ---- create the throwaway pack ----
  const created = await fetch(`${BASE}/admin/packs`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({
      slug: PACK,
      title: 'QA 1000+ Stress',
      category: 'pokemon',
      price: 1,
      image: '/images/claw/rookie-pack-icon.webp',
      buyback_percent: 90,
      boost: false,
      rank: 99,
      status: 'draft',
    }),
  });
  check(created.ok, `create pack (HTTP ${created.status})`);

  // ---- N=1 smoke: one card opens/rolls/resolves before scaling ----
  await fetch(`${BASE}/admin/packs/${PACK}/members`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ card_ids: [`${TAG}-0`] }),
  });
  await fetch(`${BASE}/admin/packs/${PACK}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({
      title: 'QA 1000+ Stress',
      category: 'pokemon',
      price: 1,
      image: '/images/claw/rookie-pack-icon.webp',
      buyback_percent: 90,
      boost: false,
      rank: 99,
      status: 'active',
    }),
  });
  const cust = await fetch(`${BASE}/auth/customer/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test@polycards.app',
      password: 'PolycardsTest123!',
    }),
  }).then((r) => r.json());
  const CH = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cust.token}`,
    'x-publishable-api-key': pub,
  };
  const me = await fetch(`${BASE}/store/customers/me`, { headers: CH }).then(
    (r) => r.json(),
  );
  await fetch(`${BASE}/admin/customers/${me.customer.id}/credits`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ amount: 100, note: 'qa-stress' }),
  });
  const smoke = await fetch(`${BASE}/store/packs/${PACK}/open`, {
    method: 'POST',
    headers: CH,
    body: '{}',
  });
  const smokeJson = await smoke.json();
  check(
    smoke.ok &&
      (smokeJson.card?.handle ?? smokeJson.pull?.card?.handle)?.startsWith(TAG),
    `N=1 smoke: Product-less synthetic card opens & resolves (HTTP ${smoke.status})`,
  );

  // ---- scale to N members (initial population of the pool) ----
  const allIds = Array.from({ length: N }, (_, i) => `${TAG}-${i}`);
  // draft first — active packs reject pool edits that could empty winnable cards
  await fetch(`${BASE}/admin/packs/${PACK}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({
      title: 'QA 1000+ Stress',
      category: 'pokemon',
      price: 1,
      image: '/images/claw/rookie-pack-icon.webp',
      buyback_percent: 90,
      boost: false,
      rank: 99,
      status: 'draft',
    }),
  });
  const pop = await time(`populate ${N} members`, () =>
    fetch(`${BASE}/admin/packs/${PACK}/members`, {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ card_ids: allIds }),
    }),
  );
  check(pop.ok, `populate pool to ${N} members (HTTP ${pop.status})`);
  const cnt1 = Number(
    psql(`SELECT count(*) FROM pack_odds WHERE pack_id='${PACK}';`),
  );
  check(
    cnt1 === N,
    `pool has ${cnt1} odds rows after initial population (expected ${N})`,
  );

  // ---- the discriminating probe: a SECOND set-members with the SAME N ----
  // Before the fix, set-pack-members read existing with take:1000, so any row
  // past the cap was unseen → treated as "missing" → re-added, silently
  // doubling that card's weight. With the paged reconcile it should now see the
  // whole pool and add nothing; the pool stays exactly N with no duplicates.
  const pop2 = await time('re-populate (cap probe)', () =>
    fetch(`${BASE}/admin/packs/${PACK}/members`, {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ card_ids: allIds }),
    }),
  );
  const cnt2 = Number(
    psql(`SELECT count(*) FROM pack_odds WHERE pack_id='${PACK}';`),
  );
  const dupes = psql(
    `SELECT card_id, count(*) c FROM pack_odds WHERE pack_id='${PACK}' GROUP BY card_id HAVING count(*) > 1 LIMIT 5;`,
  );
  console.log(
    `  second set-members: HTTP ${pop2.status}, pool row count now ${cnt2}`,
  );
  if (dupes) console.log(`  DUPLICATE card_ids detected:\n${dupes}`);
  check(
    cnt2 === N && !dupes,
    `re-populate keeps exactly ${N} rows, no duplicates (cap-safe). Got ${cnt2} rows` +
      (dupes ? ', DUPLICATES present' : ''),
  );

  // ---- DB backstop: a raw duplicate insert must be REJECTED by the index ----
  // Even if a future read regresses, UQ_pack_odds_pack_card turns the silent
  // weight-doubling into a hard error. Force it directly and expect a throw.
  let constraintBlocked = false;
  try {
    psql(
      `INSERT INTO pack_odds (id, pack_id, card_id, rarity, weight, locked)
       VALUES ('po_dup_probe','${PACK}','${TAG}-0','Common',100,false);`,
    );
  } catch {
    constraintBlocked = true;
  }
  if (!constraintBlocked)
    psql(`DELETE FROM pack_odds WHERE id='po_dup_probe';`);
  check(
    constraintBlocked,
    'DB rejects a duplicate (pack_id, card_id) insert (UQ_pack_odds_pack_card)',
  );

  // ---- surface checks against the fat pool ----
  await fetch(`${BASE}/admin/packs/${PACK}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({
      title: 'QA 1000+ Stress',
      category: 'pokemon',
      price: 1,
      image: '/images/claw/rookie-pack-icon.webp',
      buyback_percent: 90,
      boost: false,
      rank: 99,
      status: 'active',
    }),
  });
  // store pack-detail fold (Top Hits + published odds) over 1000+ members
  const detail = await time('store pack-detail fold', () =>
    fetch(`${BASE}/store/packs/${PACK}`, {
      headers: { 'x-publishable-api-key': pub },
    }),
  );
  check(
    detail.ok,
    `store /store/packs/${PACK} responds (HTTP ${detail.status})`,
  );
  // admin editor read (win-rate editor loads every row incl locked/pct)
  const editor = await time('admin odds editor read', () =>
    fetch(`${BASE}/admin/packs/${PACK}/odds`, { headers: AH }),
  );
  check(
    editor.ok,
    `admin odds editor loads 1000+ rows (HTTP ${editor.status})`,
  );
  const editorJson = await editor.json().catch(() => ({}));
  const rowsSeen = editorJson.odds?.length ?? editorJson.entries?.length ?? 0;
  check(
    rowsSeen >= N,
    `admin editor returned ${rowsSeen} rows (expected >= ${N})`,
  );

  // a few real opens against the fat pool (odds fold + roll under load)
  let opens = 0;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}/store/packs/${PACK}/open`, {
      method: 'POST',
      headers: CH,
      body: '{}',
    });
    if (r.ok) opens++;
    else if (r.status === 429) {
      i--;
      await new Promise((res) => setTimeout(res, 5000));
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  check(
    opens === 5,
    `5 opens against the ${N}-card pool all succeeded (${opens}/5)`,
  );
} finally {
  teardown();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
