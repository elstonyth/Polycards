// scripts/sim/provision.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIM, simDatabaseUrl, runDir } from './config.mjs';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: node scripts/sim/provision.mjs <runId>');
  process.exit(1);
}
const base = process.env.DATABASE_URL;
if (!base) {
  console.error('DATABASE_URL not set (source backend env first)');
  process.exit(1);
}

const simUrl = simDatabaseUrl(base);
const psql = (sql) =>
  execFileSync(
    'docker',
    [
      'exec',
      'pokenic-postgres',
      'psql',
      '-U',
      'postgres',
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

const env = { ...process.env, DATABASE_URL: simUrl, ALLOW_MOCK_TOPUP: 'true' };
const api = join(process.cwd(), 'backend', 'packages', 'api');
const yarn = (args) =>
  execFileSync('corepack', ['yarn', ...args], {
    cwd: api,
    env,
    stdio: ['inherit', 'pipe', 'inherit'],
  });

console.log('[sim] migrating + seeding');
execFileSync('corepack', ['yarn', 'medusa', 'db:migrate'], {
  cwd: api,
  env,
  stdio: 'inherit',
});
execFileSync('corepack', ['yarn', 'medusa', 'exec', './src/scripts/seed.ts'], {
  cwd: api,
  env,
  stdio: 'inherit',
});
const out = yarn([
  'medusa',
  'exec',
  './src/scripts/print-publishable-key.ts',
]).toString();
const token = (out.match(/token=(pk_[A-Za-z0-9]+)/) || [])[1];
if (!token) {
  console.error('[sim] could not capture publishable key from:\n' + out);
  process.exit(1);
}

const dir = runDir(runId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'pk.txt'), token, 'utf8');
console.log('[sim] provisioned. publishable key saved to', join(dir, 'pk.txt'));
