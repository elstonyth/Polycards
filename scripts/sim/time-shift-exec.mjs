// scripts/sim/time-shift-exec.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SIM, runDir } from './config.mjs';
import { buildShiftSql } from './time-shift.mjs';

// Resolve the sim DB role/password. Prefer DATABASE_URL (CLI use from a shell
// that exported it); otherwise fall back to runs/<runId>/db.json that provision
// wrote — this is the path the workflow uses, since its runtime has no
// DATABASE_URL in env.
function creds(runId) {
  const base = process.env.DATABASE_URL || '';
  if (base) {
    const u = new URL(base);
    return {
      user: decodeURIComponent(u.username) || 'postgres',
      pass: decodeURIComponent(u.password),
    };
  }
  if (runId) {
    const f = join(runDir(runId), 'db.json');
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      return { user: j.user || 'postgres', pass: j.pass || '' };
    }
  }
  return { user: 'postgres', pass: '' };
}

export function shiftDay(days = 1, runId) {
  const { user: pgUser, pass: pgPass } = creds(runId);
  const sql = buildShiftSql(SIM.TIME_SHIFT_TARGETS, days).join('\n');
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
      SIM.dbName,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: 'inherit' },
  );
  // Time-gated cooldowns/sessions also live in Redis; clear the sim index so a
  // shifted day is not blocked by a cached "already drew today".
  execFileSync(
    'docker',
    [
      'exec',
      'pokenic-redis',
      'redis-cli',
      '-n',
      String(SIM.redisIndex),
      'flushdb',
    ],
    { stdio: 'inherit' },
  );
}

if (process.argv[1] && process.argv[1].endsWith('time-shift-exec.mjs')) {
  // node scripts/sim/time-shift-exec.mjs <days> [runId]
  shiftDay(Number(process.argv[2] || 1), process.argv[3]);
  console.log('[sim] shifted day');
}
