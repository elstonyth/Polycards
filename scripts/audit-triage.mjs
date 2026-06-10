// Audit route triage: bucket all clone routes into diffable-vs-live / clone-only / needs-param.
// Cheap: HTTP status only, NO screenshots. Hits clone (:4000) + live phygitals.
import { writeFileSync, mkdirSync } from 'node:fs';

const CLONE = 'http://localhost:4000';
const LIVE = 'https://www.phygitals.com';
const OUT = 'docs/research/audit';
mkdirSync(OUT, { recursive: true });

// path, kind, sampleParam (for dynamic, used to probe both sites)
const ROUTES = [
  // static public — expected diffable vs live
  ['/', 'static'], ['/claw', 'static'], ['/how-it-works', 'static'],
  ['/leaderboard', 'static'], ['/marketplace', 'static'], ['/pack-party', 'static'],
  ['/about', 'static'], ['/contact', 'static'], ['/series', 'static'],
  ['/activity', 'static'], ['/fairness', 'static'], ['/free', 'static'],
  ['/store', 'static'], ['/lucky-draw', 'static'], ['/repacks', 'static'],
  ['/roulette', 'static'], ['/clawmaker', 'static'], ['/social', 'static'],
  ['/merchants', 'static'], ['/airdrop', 'static'], ['/30th', 'static'],
  ['/login', 'static'], ['/signup', 'static'],
  // account group — expected auth-gated on live (clone-only sanity)
  ['/settings', 'account'], ['/orders', 'account'], ['/messages', 'account'],
  ['/earnings', 'account'], ['/referrals', 'account'], ['/achievements', 'account'],
  ['/vouchers', 'account'], ['/submitcards', 'account'], ['/bank-withdrawal', 'account'],
  ['/borrow-lend', 'account'], ['/pokecoin', 'account'], ['/nbacoin', 'account'],
  ['/accelerate-claim', 'account'],
  // dynamic — need a sample param valid on each site
  ['/claw/starter-riftbound-pack', 'dynamic'], ['/card/1', 'dynamic'],
  ['/profile/test', 'dynamic'], ['/pokemon/generation/1', 'dynamic'],
  ['/launchpad/pokemon', 'dynamic'],
];

async function waitForServer(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function probe(base, path) {
  try {
    const r = await fetch(base + path, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 audit' } });
    const finalPath = new URL(r.url).pathname;
    const redirectedToLogin = /login|signin|sign-in|auth/i.test(finalPath) && finalPath !== path;
    return { status: r.status, finalPath, redirectedToLogin };
  } catch (e) {
    return { status: 0, error: String(e.message || e).slice(0, 80) };
  }
}

console.log('Waiting for clone server on :4000 ...');
const up = await waitForServer(CLONE + '/');
console.log('Clone server up:', up);

const rows = [];
for (const [path, kind] of ROUTES) {
  const clone = await probe(CLONE, path);
  const live = await probe(LIVE, path);
  let bucket;
  if (clone.status !== 200) bucket = 'clone-broken';
  else if (kind === 'account') bucket = (live.status === 200 && !live.redirectedToLogin) ? 'diffable' : 'clone-only';
  else if (live.status === 200 && !live.redirectedToLogin) bucket = 'diffable';
  else if (live.redirectedToLogin) bucket = 'clone-only';
  else bucket = 'needs-param-or-missing';
  rows.push({ path, kind, bucket, clone: clone.status, live: live.status, liveFinal: live.finalPath, login: !!live.redirectedToLogin });
  console.log(`${bucket.padEnd(22)} ${path.padEnd(34)} clone=${clone.status} live=${live.status}${live.redirectedToLogin ? ' →login' : ''}`);
}

const summary = {};
for (const r of rows) summary[r.bucket] = (summary[r.bucket] || 0) + 1;
writeFileSync(`${OUT}/triage.json`, JSON.stringify({ rows, summary }, null, 2));
console.log('\nSUMMARY:', JSON.stringify(summary));
console.log('Wrote', `${OUT}/triage.json`);
