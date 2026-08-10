// Phase 6b — ROLL DISTRIBUTION SHIFT proof.
//
// The headline acceptance test: when the admin raises a card's win rate, the
// actual weighted draw shifts to match. Lock the top card at 40% (baseline is
// ~0.9% — an Epic at weight 45 / Σ≈5040), then open the pack N times as a real
// customer and confirm that card wins ~40% of the time (vs ~0.9% before).
//
// Cleans up after itself: restores pokemon-mythic's seed odds and deletes the
// simulation's Pull rows (by the throwaway customer's id) so the demo ledger
// stays clean.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:9000';
const SLUG = 'pokemon-mythic';
const N = 150;
const PK = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY='))
  ?.split('=')[1]
  ?.replace(/['"]/g, '')
  .trim();

const j = async (res) => ({
  status: res.status,
  body: await res.json().catch(() => ({})),
});

// --- admin: lock the top card at 40% ---
const adminTok = (
  await (
    await fetch(`${API}/auth/user/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@polycards.local',
        password: 'polycardsadmin2026',
      }),
    })
  ).json()
).token;
const AH = {
  Authorization: `Bearer ${adminTok}`,
  'Content-Type': 'application/json',
};

const odds = (
  await (await fetch(`${API}/admin/packs/${SLUG}/odds`, { headers: AH })).json()
).odds;
const topId = odds[0].card_id;
const baselinePct = odds[0].pct;
await fetch(`${API}/admin/packs/${SLUG}/odds`, {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({
    entries: odds.map((o, i) => ({
      card_id: o.card_id,
      locked: i === 0,
      pct: i === 0 ? 40 : 0,
    })),
  }),
});

// --- customer: register + login a throwaway buyer ---
const SH = { 'Content-Type': 'application/json', 'x-publishable-api-key': PK };
const email = `roll-sim-${Date.now()}@polycards.local`;
const password = 'rollsim2026';
const regTok = (
  await (
    await fetch(`${API}/auth/customer/emailpass/register`, {
      method: 'POST',
      headers: SH,
      body: JSON.stringify({ email, password }),
    })
  ).json()
).token;
await fetch(`${API}/store/customers`, {
  method: 'POST',
  headers: { ...SH, Authorization: `Bearer ${regTok}` },
  body: JSON.stringify({ email }),
});
const loginTok = (
  await (
    await fetch(`${API}/auth/customer/emailpass`, {
      method: 'POST',
      headers: SH,
      body: JSON.stringify({ email, password }),
    })
  ).json()
).token;
const CH = { ...SH, Authorization: `Bearer ${loginTok}` };
const meId = (
  await (await fetch(`${API}/store/customers/me`, { headers: CH })).json()
).customer.id;

// --- open N times, tally the won card ---
const tally = {};
let opened = 0;
for (let i = 0; i < N; i++) {
  const res = await j(
    await fetch(`${API}/store/packs/${SLUG}/open`, {
      method: 'POST',
      headers: CH,
    }),
  );
  if (res.status === 200 && res.body.card) {
    const h = res.body.card.handle;
    tally[h] = (tally[h] || 0) + 1;
    opened++;
  }
}
const topWins = tally[topId] || 0;
const topFreqPct = opened ? (topWins / opened) * 100 : 0;

// --- cleanup: delete sim pulls + restore seed odds ---
// -i so docker forwards stdin. The SQL goes in on stdin rather than via -c
// because psql only interpolates :'var' for a script it reads — NOT inside -c,
// where ":'id'" is just a syntax error (verified against the running container).
const PSQL_ARGV = [
  'exec',
  '-i',
  'pokenic-postgres',
  'psql',
  '-U',
  'medusa',
  '-d',
  'medusa',
  '-v',
  'ON_ERROR_STOP=1',
];
const psql = (sql, vars) =>
  execFileSync('docker', [...PSQL_ARGV, ...vars], {
    input: sql,
    stdio: 'pipe',
  });
// meId comes off the /store/customers/me response, so it must not be pasted
// into either a command line or a SQL string. execFileSync drops the shell, and
// psql quotes the value server-side, so both layers treat it as data.
psql("DELETE FROM pull WHERE customer_id = :'id';", ['-v', `id=${meId}`]);
psql(
  // rarity lives on pack_odds now; the old `FROM card c ... c.rarity` join
  // errors with "column c.rarity does not exist" (card no longer carries it).
  "UPDATE pack_odds SET weight = CASE rarity WHEN 'Legendary' THEN 5 WHEN 'Epic' THEN 45 WHEN 'Rare' THEN 150 WHEN 'Uncommon' THEN 300 WHEN 'Common' THEN 500 ELSE 100 END, locked = false WHERE pack_id = :'slug';",
  ['-v', `slug=${SLUG}`],
);

const out = {
  topCard: topId,
  baselinePct,
  targetPct: 40,
  opened,
  topWins,
  topFreqPct: Number(topFreqPct.toFixed(1)),
  // 40% ± 12 (≈3σ for N=150) — a generous band that still cleanly excludes the
  // ~0.9% baseline, proving the saved win rate drives the draw.
  withinBand: topFreqPct >= 28 && topFreqPct <= 52,
};
out.verdict =
  out.withinBand && opened === N
    ? 'PASS (roll shifted to the saved win rate)'
    : 'FAIL';
console.log(JSON.stringify(out, null, 2));
