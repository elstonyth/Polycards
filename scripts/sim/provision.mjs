// scripts/sim/provision.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIM, simDatabaseUrl, runDir } from './config.mjs';

// Read DATABASE_URL from env, or fall back to the backend env file (read in
// Node, not a shell read) so this runs without the caller exporting it.
function resolveBase() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envText = readFileSync(
      join(process.cwd(), 'backend', 'packages', 'api', '.env'),
      'utf8',
    );
    const m = envText.match(/^DATABASE_URL=(.*)$/m);
    if (m)
      return m[1]
        .trim()
        .replace(/\r$/, '')
        .replace(/^["']|["']$/g, '');
  } catch {
    /* fall through */
  }
  return null;
}

const runId = process.argv[2];
if (!runId) {
  console.error('usage: node scripts/sim/provision.mjs <runId>');
  process.exit(1);
}
if (!/^[\w-]+$/.test(runId)) {
  console.error('runId must be [A-Za-z0-9_-]');
  process.exit(1);
}
const base = resolveBase();
if (!base) {
  console.error('DATABASE_URL not found (env or backend/packages/api/.env)');
  process.exit(1);
}

const simUrl = simDatabaseUrl(base);
// Derive the psql role / password / maintenance-db from DATABASE_URL so we
// always connect the way the backend does — the container superuser is NOT
// necessarily "postgres". DROP/CREATE run against the existing base db
// (pixelslot_sim does not exist yet), passing PGPASSWORD via the container env
// (never argv/logs) in case socket auth isn't trust.
const dbu = new URL(base);
const pgUser = decodeURIComponent(dbu.username) || 'postgres';
const pgPass = decodeURIComponent(dbu.password);
const maintenanceDb =
  decodeURIComponent(dbu.pathname.replace(/^\//, '')) || 'postgres';
const psql = (sql) =>
  execFileSync(
    'docker',
    [
      'exec',
      ...(pgPass ? ['-e', `PGPASSWORD=${pgPass}`] : []),
      'pokenic-postgres',
      'psql',
      '-U',
      pgUser,
      '-d',
      maintenanceDb,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: 'inherit' },
  );

console.log('[sim] recreating database', SIM.dbName);
psql(`DROP DATABASE IF EXISTS ${SIM.dbName} WITH (FORCE);`);
psql(`CREATE DATABASE ${SIM.dbName};`);

const env = {
  ...process.env,
  DATABASE_URL: simUrl,
  ALLOW_MOCK_TOPUP: 'true',
  // Harmless here; the load-bearing setting is on the backend process itself
  // (see PILOT.md step 3) since the daily-draw gate reads it at request time.
  REWARDS_REDEMPTION_ENABLED: 'true',
};
const api = join(process.cwd(), 'backend', 'packages', 'api');
// Run the medusa CLI directly with node (process.execPath). corepack/yarn are
// not reliably resolvable via execFileSync on Windows (corepack ENOENT, no
// .cmd resolution) and Yarn Berry has no `medusa` passthrough. The CLI entry is
// @medusajs/cli/cli.js (its bin is "medusa").
const MEDUSA_CLI = join(api, 'node_modules', '@medusajs', 'cli', 'cli.js');
const medusa = (mArgs, mEnv = env, capture = false) =>
  execFileSync(process.execPath, [MEDUSA_CLI, ...mArgs], {
    cwd: api,
    env: mEnv,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });

console.log('[sim] migrating + seeding');
medusa(['db:migrate']);
medusa(['exec', './src/scripts/seed.ts']);

console.log('[sim] provisioning admin user');
const adminEnv = {
  ...env,
  ADMIN_EMAIL: 'sim-admin@pixelslot.local',
  ADMIN_PASSWORD: 'SimAdmin2026!',
};
medusa(['exec', './src/scripts/create-admin.ts'], adminEnv);

// Enable the tier-a daily reward box so the daily draw actually draws (new
// customers are tier a; its box ships disabled/no-prizes). Without this the
// draw returns {status:'unavailable'} and the Day1→Day2 time-shift is untestable.
console.log('[sim] enabling tier-a daily box');
medusa(['exec', './src/scripts/seed-sim-daily-box.ts']);

const out = medusa(
  ['exec', './src/scripts/print-publishable-key.ts'],
  env,
  true,
).toString();
const token = (out.match(/token=(pk_[A-Za-z0-9]+)/) || [])[1];
if (!token) {
  console.error('[sim] could not capture publishable key from:\n' + out);
  process.exit(1);
}

const dir = runDir(runId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'pk.txt'), token, 'utf8');

const diaryDir = join(dir, 'diary');
mkdirSync(diaryDir, { recursive: true });
writeFileSync(
  join(diaryDir, 'admin.md'),
  [
    '# Admin credentials',
    '',
    'email: sim-admin@pixelslot.local',
    'password: SimAdmin2026!',
    '',
    'Log in via POST /auth/user/emailpass to get your admin token.',
    '',
  ].join('\n'),
  'utf8',
);

// Persist the sim DB role/password so the day time-shift can connect from the
// workflow runtime (which has no DATABASE_URL in its env). Local sim creds in a
// gitignored runs/ dir — never committed.
writeFileSync(
  join(dir, 'db.json'),
  JSON.stringify({ user: pgUser, pass: pgPass }),
  'utf8',
);

console.log('[sim] provisioned. publishable key saved to', join(dir, 'pk.txt'));
console.log('[sim] admin creds written to', join(diaryDir, 'admin.md'));
