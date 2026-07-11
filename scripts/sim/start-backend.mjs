// scripts/sim/start-backend.mjs
// Launch the sim backend against pixelslot_sim — robustly. The shell one-liner
// version was fragile (CRLF in .env left a trailing \r that broke the URL
// swap, so DATABASE_URL came out empty and medusa silently fell back to the
// .env db). This reads DATABASE_URL from the backend .env in Node, swaps the db
// name to the sim db the same way provision.mjs does, sets the two gates the
// sim needs, and spawns `medusa develop` with that env injected into the child
// (which is what actually wins over .env — proven by provision). Prints only the
// db NAME, never the connection string.
//
// Usage:  node scripts/sim/start-backend.mjs           (starts the backend)
//         node scripts/sim/start-backend.mjs --dry-run  (prints the db name and exits)
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SIM, simDatabaseUrl, simRedisUrl } from './config.mjs';

const api = join(process.cwd(), 'backend', 'packages', 'api');
const envText = readFileSync(join(api, '.env'), 'utf8');
const readEnv = (key) => {
  const m = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) return null;
  return m[1]
    .trim()
    .replace(/\r$/, '')
    .replace(/^["']|["']$/g, '');
};
const base = readEnv('DATABASE_URL');
if (!base) {
  console.error('[sim] DATABASE_URL not found in backend .env');
  process.exit(1);
}
const simUrl = simDatabaseUrl(base);
// Redis index 9 (SIM.redisIndex): without this the child inherits the dev
// REDIS_URL (index 0, shared state with the dev backend) while the day-shift
// flushes index 9 — a flush nothing uses.
const simRedis = simRedisUrl(readEnv('REDIS_URL'));
const dbName = new URL(simUrl).pathname.slice(1);

if (dbName !== SIM.dbName) {
  console.error(
    `[sim] refusing to start: resolved db "${dbName}" != "${SIM.dbName}"`,
  );
  process.exit(1);
}
const simPort = new URL(SIM.backendUrl).port || '9000';
console.log(
  `[sim] backend → db "${dbName}" on :${simPort}, redis index ${SIM.redisIndex} (ALLOW_MOCK_TOPUP + REWARDS_REDEMPTION_ENABLED)`,
);

if (process.argv.includes('--dry-run')) process.exit(0);

const env = {
  ...process.env,
  DATABASE_URL: simUrl,
  REDIS_URL: simRedis,
  PORT: simPort,
  ALLOW_MOCK_TOPUP: 'true',
  REWARDS_REDEMPTION_ENABLED: 'true',
};
const cli = join(api, 'node_modules', '@medusajs', 'cli', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'develop'], {
  cwd: api,
  env,
  stdio: 'inherit',
});
process.exit(r.status ?? 0);
