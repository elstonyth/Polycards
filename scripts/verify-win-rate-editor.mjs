// Phase 6b — admin win-rate editor verification (HTTP, against live :9000).
//
// Proves the editor's API surface end to end:
//   1. admin-only (unauth GET /admin/packs/:slug/odds -> 401)
//   2. save normalizes to basis points: lock the top card at 40% -> it gets 4000
//      bps, the 15 unlocked split 6000 evenly (400 each), Σ == 10000 exactly
//   3. the save persists (GET reflects locked=true, pct=40, others pct≈4)
//   4. NO-LEAK AFTER EDIT: the customer GET /store/packs/:slug still returns no
//      `weight`, and the customer odds are unaffected (decoupled)
//   5. validation rejects: Σlocked > 100 -> 400; all-locked but Σ ≠ 100 -> 400
// Finally restores pokemon-mythic to its seed (rarity-weighted) odds via SQL so
// the demo data stays pristine.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:9000';
const SLUG = 'pokemon-mythic';
const PK = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY='))
  ?.split('=')[1]
  ?.replace(/['"]/g, '')
  .trim();

const r = { checks: {} };
const ok = (name, cond, detail) => {
  r.checks[name] = cond ? 'PASS' : `FAIL${detail ? ' — ' + detail : ''}`;
};

async function adminToken() {
  const res = await fetch(`${API}/auth/user/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@pokenic.local',
      password: 'pokenicadmin2026',
    }),
  });
  return (await res.json()).token;
}

const TOKEN = await adminToken();
const AH = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// 1. admin-only
{
  const res = await fetch(`${API}/admin/packs/${SLUG}/odds`);
  ok('unauth_blocked', res.status === 401, `status ${res.status}`);
}

// load current odds
const before = await (
  await fetch(`${API}/admin/packs/${SLUG}/odds`, { headers: AH })
).json();
const rows = before.odds;
ok('get_odds_16_rows', rows.length === 16, `got ${rows.length}`);
const topId = rows[0].card_id;

// 2 + 3. save: lock top @ 40%, rest unlocked
{
  const entries = rows.map((o, i) => ({
    card_id: o.card_id,
    locked: i === 0,
    pct: i === 0 ? 40 : 0,
  }));
  const res = await fetch(`${API}/admin/packs/${SLUG}/odds`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ entries }),
  });
  const j = await res.json();
  const sum = (j.odds || []).reduce((s, o) => s + o.weight, 0);
  const top = (j.odds || []).find((o) => o.card_id === topId);
  const others = (j.odds || []).filter((o) => o.card_id !== topId);
  ok('save_ok', res.ok, `status ${res.status}`);
  ok('save_sum_10000', sum === 10000, `Σ=${sum}`);
  ok(
    'save_locked_4000',
    top?.weight === 4000 && top?.locked === true,
    JSON.stringify(top),
  );
  ok(
    'save_even_split_400',
    others.every((o) => o.weight === 400),
    [...new Set(others.map((o) => o.weight))].join(','),
  );

  // persisted?
  const after = await (
    await fetch(`${API}/admin/packs/${SLUG}/odds`, { headers: AH })
  ).json();
  const topAfter = after.odds.find((o) => o.card_id === topId);
  ok(
    'persisted_locked_40pct',
    topAfter?.locked === true && topAfter?.pct === 40,
    JSON.stringify(topAfter),
  );
  const othersAfter = after.odds.filter((o) => o.card_id !== topId);
  ok(
    'persisted_others_4pct',
    othersAfter.every((o) => o.pct === 4),
    [...new Set(othersAfter.map((o) => o.pct))].join(','),
  );
}

// 4. no-leak after edit (customer surface)
{
  const res = await fetch(`${API}/store/packs/${SLUG}`, {
    headers: { 'x-publishable-api-key': PK },
  });
  const j = await res.json();
  const entries = j.odds || [];
  ok(
    'customer_no_weight',
    !entries.some((e) => 'weight' in e),
    `keys: ${Object.keys(entries[0] || {})}`,
  );
  ok('customer_16_cards', entries.length === 16, `got ${entries.length}`);
}

// 5. validation rejects
{
  // Σlocked > 100: lock two cards at 60 + 50
  const e1 = rows.map((o, i) => ({
    card_id: o.card_id,
    locked: i < 2,
    pct: i === 0 ? 60 : i === 1 ? 50 : 0,
  }));
  const res1 = await fetch(`${API}/admin/packs/${SLUG}/odds`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ entries: e1 }),
  });
  ok('reject_over_100', res1.status >= 400, `status ${res1.status}`);

  // all locked but Σ ≠ 100: every card locked at 1% (Σ=16)
  const e2 = rows.map((o) => ({ card_id: o.card_id, locked: true, pct: 1 }));
  const res2 = await fetch(`${API}/admin/packs/${SLUG}/odds`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ entries: e2 }),
  });
  ok('reject_all_locked_not_100', res2.status >= 400, `status ${res2.status}`);
}

// restore seed (rarity-weighted) odds so the demo stays pristine
execSync(
  `docker exec pokenic-postgres psql -U medusa -d medusa -c "UPDATE pack_odds po SET weight = CASE c.rarity WHEN 'Legendary' THEN 5 WHEN 'Epic' THEN 45 WHEN 'Rare' THEN 150 WHEN 'Uncommon' THEN 300 WHEN 'Common' THEN 500 ELSE 100 END, locked = false FROM card c WHERE po.card_id = c.handle AND po.pack_id = '${SLUG}';"`,
  { stdio: 'pipe' },
);
const restored = await (
  await fetch(`${API}/admin/packs/${SLUG}/odds`, { headers: AH })
).json();
const topRestored = restored.odds.find((o) => o.card_id === topId);
ok(
  'restored_seed',
  topRestored?.locked === false && topRestored?.pct !== 40,
  JSON.stringify(topRestored),
);

r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
  ? 'PASS'
  : 'FAIL';
console.log(JSON.stringify(r, null, 2));
