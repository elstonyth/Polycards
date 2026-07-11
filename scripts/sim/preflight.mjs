// scripts/sim/preflight.mjs
// Day-0 identity guard (spec §4: "health-check → fail loudly, never produce
// garbage findings"). A plain /health probe is NOT enough: a dev backend
// listening on the sim port answers it against the WRONG db (this really
// happened — see the :9100 comment in config.mjs). So prove the backend is
// the one provision.mjs just built, via two facts only that provision creates:
//   1. the publishable key in runs/<runId>/pk.txt validates on /store/*
//   2. the sim admin user can log in (created only in pixelslot_sim)
// Either failing means eight adversarial agents would act against a real dev
// DB and file garbage findings — abort before any agent moves.
//
// Usage: node scripts/sim/preflight.mjs <runId>   → exit 0 ok / exit 1 abort
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIM, runDir } from './config.mjs';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: node scripts/sim/preflight.mjs <runId>');
  process.exit(1);
}

function fail(msg) {
  console.error(
    `[sim] PREFLIGHT FAILED: ${msg}\n` +
      `[sim] The backend on ${SIM.backendUrl} is not the provisioned sim ` +
      `backend — do NOT run the month. Start it with ` +
      `\`node scripts/sim/start-backend.mjs\` after \`provision.mjs ${runId}\`.`,
  );
  process.exit(1);
}

const get = (path, headers) =>
  fetch(`${SIM.backendUrl}${path}`, { headers }).catch(() => null);

const health = await get('/health');
if (!health || !health.ok)
  fail(
    `no healthy backend (${health ? `status ${health.status}` : 'unreachable'})`,
  );

// Probe 1: this run's publishable key. A backend on the dev DB rejects it.
const pk = readFileSync(join(runDir(runId), 'pk.txt'), 'utf8').trim();
const store = await get('/store/regions?limit=1', {
  'x-publishable-api-key': pk,
});
if (!store || store.status !== 200)
  fail(
    `the run's publishable key was rejected (${store ? `status ${store.status}` : 'unreachable'}) — wrong database behind the port`,
  );

// Probe 2: the sim admin exists only in pixelslot_sim (creds match
// provision.mjs and runs/<runId>/diary/admin.md).
const login = await fetch(`${SIM.backendUrl}/auth/user/emailpass`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'sim-admin@pixelslot.local',
    password: 'SimAdmin2026!',
  }),
}).catch(() => null);
if (!login || login.status !== 200)
  fail(
    `sim admin login refused (${login ? `status ${login.status}` : 'unreachable'}) — wrong database behind the port`,
  );

console.log(
  `[sim] preflight OK — ${SIM.backendUrl} is the provisioned sim backend (pk + sim-admin verified)`,
);
