// scripts/sim/demo-events.mjs
// Feed a lifelike sequence of events into the live viewer so you can SEE voxel
// customers walk in, play slots, complain, queue at the admin, and findings pop
// — without running the real backend/agents. Just drives the SSE feed.
//   node scripts/sim/demo-events.mjs [runId]
import { appendEvent } from './event-log.mjs';
import { runDir } from './config.mjs';

const dir = runDir(process.argv[2] || 'pilot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = {};
const ev = (actor, kind, detail) =>
  appendEvent(dir, { day: 1, actor, kind, detail });

// [actor, kind, detail, delayMsAfter]
const seq = [
  ['honest', 'arrived', { balance: 100 }, 900],
  ['refund-seeker', 'arrived', { balance: 80 }, 900],
  ['honest', 'played_pack', { slot: 'slot2', balance: 75 }, 1400],
  ['newbie', 'arrived', { balance: 50 }, 900],
  ['honest', 'pull_result', { rarity: 'common' }, 1200],
  ['refund-seeker', 'played_pack', { slot: 'slot3', balance: 55 }, 1400],
  ['high-roller', 'arrived', { balance: 500 }, 900],
  ['high-roller', 'played_pack', { slot: 'slot1', balance: 380 }, 1400],
  ['high-roller', 'pull_result', { rarity: 'legendary' }, 1500],
  ['refund-seeker', 'complained', {}, 1500],
  ['admin', 'admin_picked_up', { customer: 'refund-seeker' }, 1400],
  ['newbie', 'played_pack', { slot: 'slot1', balance: 30 }, 1300],
  [
    'auditor',
    'finding',
    {
      category: 'bug',
      severity: 'high',
      summary: 'topup double-credits on a retried request',
    },
    1200,
  ],
  ['admin', 'admin_resolved', { customer: 'refund-seeker' }, 1200],
  ['refund-seeker', 'played_pack', { slot: 'slot2', balance: 75 }, 1400],
  [
    'auditor',
    'finding',
    {
      category: 'missing-capability',
      severity: 'critical',
      summary: 'no partial-refund endpoint for the admin',
    },
    1200,
  ],
  ['honest', 'played_pack', { slot: 'slot3', balance: 55 }, 1400],
  ['high-roller', 'complained', {}, 1400],
  ['admin', 'admin_picked_up', { customer: 'high-roller' }, 1400],
  ['admin', 'admin_resolved', { customer: 'high-roller' }, 1000],
];

console.log(
  `[demo] streaming ${seq.length} events into ${dir} — watch http://localhost:4500`,
);
for (const [actor, kind, detail, delay] of seq) {
  if (detail && detail.balance != null) bal[actor] = detail.balance;
  ev(actor, kind, detail);
  await sleep(delay);
}
console.log('[demo] done');
