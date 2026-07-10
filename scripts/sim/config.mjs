import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SIM = Object.freeze({
  dbName: 'pixelslot_sim',
  redisIndex: 9,
  viewerPort: 4500,
  backendUrl: 'http://localhost:9000',
  // Persona ids match diary filenames and event `actor` fields.
  personas: [
    { id: 'honest', label: 'Honest', color: '#4ade80' },
    { id: 'refund-seeker', label: 'Refund Seeker', color: '#f87171' },
    { id: 'exploit-hunter', label: 'Exploit Hunter', color: '#a78bfa' },
    { id: 'newbie', label: 'Confused Newbie', color: '#fbbf24' },
    { id: 'high-roller', label: 'High Roller', color: '#38bdf8' },
    { id: 'referral-schemer', label: 'Referral Schemer', color: '#fb923c' },
    { id: 'impatient-shipper', label: 'Impatient Shipper', color: '#f472b6' },
    { id: 'buyback-haggler', label: 'Buyback Haggler', color: '#2dd4bf' },
  ],
  // Canvas floor coordinates (grid units; the page scales them).
  stations: {
    entrance: { x: 1, y: 5 },
    slot1: { x: 5, y: 2 },
    slot2: { x: 5, y: 5 },
    slot3: { x: 5, y: 8 },
    vault: { x: 9, y: 2 },
    desk: { x: 12, y: 5 },
  },
  // Columns rewritten by the day time-shift. `timestamp` moves back 1 day;
  // `textday` rewrites a YYYY-MM-DD string back 1 day. The daily draw keys on
  // reward_draw.draw_day (plain text) — a timestamp-only shift would NOT
  // re-open the daily draw. Verified: models/reward-draw.ts. The pilot expands
  // this list if any other time-gated feature fails to re-fire.
  TIME_SHIFT_TARGETS: [
    { table: 'reward_draw', column: 'draw_day', kind: 'textday' },
    { table: 'reward_draw', column: 'created_at', kind: 'timestamp' },
    { table: 'credit_transaction', column: 'created_at', kind: 'timestamp' },
    { table: 'pull', column: 'created_at', kind: 'timestamp' },
    { table: 'vip_member_state', column: 'updated_at', kind: 'timestamp' },
    { table: 'commission', column: 'created_at', kind: 'timestamp' },
  ],
});

export function runDir(runId) {
  return join(HERE, 'runs', runId);
}

// Swap ONLY the path segment (db name), preserving credentials + query string.
export function simDatabaseUrl(baseUrl) {
  const u = new URL(baseUrl);
  u.pathname = `/${SIM.dbName}`;
  return u.toString();
}
