# Virtual Month Simulation — Phase 1 Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the harness that lets 10 Opus agents run a live, watchable, adversarial simulated month against the real PixelSlot backend, and prove it end-to-end with a 2-day pilot.

**Architecture:** Zero-dependency Node ESM scripts under `scripts/sim/`. Agents act via HTTP against a dedicated `pixelslot_sim` Postgres DB and emit _semantic_ events to `events.jsonl`. A zero-dep SSE server tails that file and a `<canvas>` page renders a pixel arcade floor + data sidebar. A time-shift step rewrites both timestamp and text-day columns between days. Pure logic (event log, choreography, ledger, time-shift SQL, HTTP request building) is unit-tested with `node:test`; integration is proven by the pilot.

**Tech Stack:** Node 24 ESM (`.mjs`), `node:http`, `node:fs`, `node:test`, `node:assert`, SSE, HTML5 `<canvas>`. Backend: Medusa 2.13.4 (`corepack yarn` in `backend/packages/api`). DB ops via `docker exec pokenic-postgres psql`. The month run is driven by the Workflow tool (`scriptPath` → `run-month.workflow.mjs`).

## Global Constraints

- **Node ≥ 24** at repo root; backend workspace is Node ≥ 20 via `corepack yarn`. Copy verbatim from `package.json`.
- **Zero runtime dependencies in `scripts/sim/`** — `node:*` built-ins only. No npm installs. (`ponytail`; matches the repo's self-contained `scripts/*.mjs` convention.)
- **The live viewer is exactly two files** — `viewer.mjs` (server) + `viewer.html` (page). No art assets, no CDN.
- **Never print secret-file values.** `backend/packages/api/.env` is guarded by a PreToolUse hook. Read `DATABASE_URL`/`REDIS_URL` at runtime from `process.env`; never echo them. Grep for key _names_ only.
- **`ALLOW_MOCK_TOPUP=true`** must be set for the sim backend process — verified in `src/modules/packs/topup.ts` (`mockTopupAllowed`). Amounts ending in `.13` are declined by design (`mockCharge`).
- **Sim DB name:** `pixelslot_sim`. **Sim Redis index:** `9`. **Viewer port:** `4500`. **Backend port:** `9000`.
- **DB containers already up:** `pokenic-postgres` (5432), `pokenic-redis` (6379), `--restart unless-stopped`.
- **Tests:** `node --test scripts/sim/` (added as root script `sim:test`). Backend is transpile-only at dev time; the repo Stop hook type-checks — keep sim scripts `.mjs` (not type-checked) so they don't enter the tsc gate.
- **Auditor rule:** infrastructure errors (`ECONNREFUSED`, Knex pool timeouts, `429` on normal use) are **not findings**.
- **All artifacts** live under `scripts/sim/runs/<run-id>/` (`events.jsonl`, `inbox.jsonl`, `findings.jsonl`, `diary/`, `day-*.md`). `scripts/sim/runs/` is gitignored.

---

### Task 1: Sim scaffolding + config + gitignore + test wiring

**Files:**

- Create: `scripts/sim/config.mjs`
- Create: `scripts/sim/.gitignore`
- Modify: `package.json:37` (add `sim:test` script after `"test"`)
- Test: `scripts/sim/config.test.mjs`

**Interfaces:**

- Produces: `SIM` (frozen object) with `dbName:'pixelslot_sim'`, `redisIndex:9`, `viewerPort:4500`, `backendUrl:'http://localhost:9000'`, `personas` (array of 8 `{id,label,color}`), `stations` (map `name → {x,y}`), `TIME_SHIFT_TARGETS` (array of `{table,column,kind}`).
- Produces: `runDir(runId)` → absolute path string; `simDatabaseUrl(baseUrl)` → base URL with db name swapped to `pixelslot_sim`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM, simDatabaseUrl, runDir } from './config.mjs';

test('has 8 personas with unique ids and colors', () => {
  assert.equal(SIM.personas.length, 8);
  assert.equal(new Set(SIM.personas.map((p) => p.id)).size, 8);
  assert.ok(SIM.personas.every((p) => /^#[0-9a-f]{6}$/i.test(p.color)));
});

test('time-shift targets include the daily-draw text day', () => {
  const t = SIM.TIME_SHIFT_TARGETS.find(
    (x) => x.table === 'reward_draw' && x.column === 'draw_day',
  );
  assert.equal(t.kind, 'textday');
});

test('simDatabaseUrl swaps only the database name', () => {
  const out = simDatabaseUrl('postgres://u:p@localhost:5432/pokenic?ssl=false');
  assert.equal(out, 'postgres://u:p@localhost:5432/pixelslot_sim?ssl=false');
});

test('runDir is under scripts/sim/runs', () => {
  assert.match(runDir('r1').replaceAll('\\', '/'), /scripts\/sim\/runs\/r1$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/config.test.mjs`
Expected: FAIL — `Cannot find module './config.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/config.mjs
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/config.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Add scaffolding files**

```
# scripts/sim/.gitignore
runs/
```

Modify `package.json` — add after the `"test": "vitest run",` line (currently `package.json:37`):

```json
    "test": "vitest run",
    "sim:test": "node --test scripts/sim/",
```

- [ ] **Step 6: Verify the wired script runs**

Run: `npm run sim:test`
Expected: PASS (config tests run; other `*.test.mjs` not yet present is fine).

- [ ] **Step 7: Commit**

```bash
git add -f scripts/sim/config.mjs scripts/sim/config.test.mjs scripts/sim/.gitignore package.json
git commit -m "feat(sim): scaffold harness config, personas, time-shift targets"
```

---

### Task 2: Event log (append + read)

**Files:**

- Create: `scripts/sim/event-log.mjs`
- Test: `scripts/sim/event-log.test.mjs`

**Interfaces:**

- Consumes: `runDir` from `config.mjs`.
- Produces: `appendEvent(dir, event)` → appends one JSON line (adds `seq` integer and `day` passthrough) with `O_APPEND`; returns the written record. `readEvents(dir)` → array of parsed records (empty array if file missing). Event shape: `{ day, actor, kind, detail? }`; `kind` ∈ `arrived|played_pack|pull_result|complained|admin_picked_up|admin_resolved|finding|left`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/event-log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from './event-log.mjs';

function fresh() {
  return mkdtempSync(join(tmpdir(), 'sim-ev-'));
}

test('append then read round-trips and assigns increasing seq', () => {
  const dir = fresh();
  appendEvent(dir, { day: 1, actor: 'honest', kind: 'arrived' });
  appendEvent(dir, {
    day: 1,
    actor: 'honest',
    kind: 'played_pack',
    detail: { slot: 'slot1' },
  });
  const evs = readEvents(dir);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].seq, 0);
  assert.equal(evs[1].seq, 1);
  assert.equal(evs[1].detail.slot, 'slot1');
});

test('readEvents returns [] when the log does not exist yet', () => {
  assert.deepEqual(readEvents(fresh()), []);
});

test('concurrent appends do not interleave within a line', () => {
  const dir = fresh();
  for (let i = 0; i < 50; i++)
    appendEvent(dir, { day: 1, actor: 'x', kind: 'arrived' });
  const evs = readEvents(dir);
  assert.equal(evs.length, 50);
  assert.deepEqual(
    evs.map((e) => e.seq),
    [...Array(50).keys()],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/event-log.test.mjs`
Expected: FAIL — `Cannot find module './event-log.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/event-log.mjs
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

const fileOf = (dir) => join(dir, 'events.jsonl');

// seq is derived from current line count so it survives process restarts and
// stays correct under concurrent single-process appends (O_APPEND is atomic
// for writes under PIPE_BUF; one JSON line is well under that).
export function appendEvent(dir, event) {
  mkdirSync(dir, { recursive: true });
  const path = fileOf(dir);
  const seq = existsSync(path) ? countLines(readFileSync(path, 'utf8')) : 0;
  const record = { seq, ...event };
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, JSON.stringify(record) + '\n');
  } finally {
    closeSync(fd);
  }
  return record;
}

export function readEvents(dir) {
  const path = fileOf(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function countLines(text) {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/event-log.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add -f scripts/sim/event-log.mjs scripts/sim/event-log.test.mjs
git commit -m "feat(sim): append-only semantic event log"
```

---

### Task 3: Choreography (event → sprite intent)

**Files:**

- Create: `scripts/sim/choreography.mjs`
- Test: `scripts/sim/choreography.test.mjs`

**Interfaces:**

- Consumes: `SIM.stations` from `config.mjs`.
- Produces: `targetFor(event)` → `{ x, y, mood }` where `mood` ∈ `neutral|happy|angry|busy`. Pure function; the viewer calls it to decide where each sprite walks and how it looks. Unknown `kind` → entrance/neutral (never throws — the viewer must not crash on a new event kind).

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/choreography.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetFor } from './choreography.mjs';
import { SIM } from './config.mjs';

test('playing a pack sends the sprite to the named slot', () => {
  const t = targetFor({ kind: 'played_pack', detail: { slot: 'slot3' } });
  assert.deepEqual({ x: t.x, y: t.y }, SIM.stations.slot3);
  assert.equal(t.mood, 'busy');
});

test('complaining marches the sprite to the desk, angry', () => {
  const t = targetFor({ kind: 'complained' });
  assert.deepEqual({ x: t.x, y: t.y }, SIM.stations.desk);
  assert.equal(t.mood, 'angry');
});

test('a legendary pull is happy', () => {
  assert.equal(
    targetFor({ kind: 'pull_result', detail: { rarity: 'legendary' } }).mood,
    'happy',
  );
});

test('unknown kind falls back to entrance without throwing', () => {
  const t = targetFor({ kind: 'not-a-real-kind' });
  assert.deepEqual({ x: t.x, y: t.y }, SIM.stations.entrance);
  assert.equal(t.mood, 'neutral');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/choreography.test.mjs`
Expected: FAIL — `Cannot find module './choreography.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/choreography.mjs
import { SIM } from './config.mjs';

// Pure map from a semantic event to where the sprite should be and how it
// looks. The viewer owns ALL motion; agents never describe pixels.
export function targetFor(event) {
  const s = SIM.stations;
  switch (event.kind) {
    case 'arrived':
      return { ...s.entrance, mood: 'neutral' };
    case 'played_pack': {
      const slot = s[event.detail?.slot] ?? s.slot1;
      return { ...slot, mood: 'busy' };
    }
    case 'pull_result':
      return {
        ...s.slot1,
        mood: event.detail?.rarity === 'legendary' ? 'happy' : 'neutral',
      };
    case 'complained':
      return { ...s.desk, mood: 'angry' };
    case 'admin_picked_up':
    case 'admin_resolved':
      return { ...s.desk, mood: 'busy' };
    case 'left':
      return { ...s.entrance, mood: 'neutral' };
    default:
      return { ...s.entrance, mood: 'neutral' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/choreography.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add -f scripts/sim/choreography.mjs scripts/sim/choreography.test.mjs
git commit -m "feat(sim): pure event->sprite choreography map"
```

---

### Task 4: Findings ledger (dedup + severity gate)

**Files:**

- Create: `scripts/sim/ledger.mjs`
- Test: `scripts/sim/ledger.test.mjs`

**Interfaces:**

- Consumes: `runDir` from `config.mjs`.
- Produces:
  - `findingKey(f)` → stable dedup string from `category` + sorted `endpoints` + normalized `summary`.
  - `recordFinding(dir, f)` → appends to `findings.jsonl` only if `findingKey` is new for that run; returns `{ added: boolean, key }`.
  - `blocksGate(f)` → `true` when `status === 'confirmed'`, `category ∈ {bug, missing-capability}`, and `severity ∈ {critical, high}`; else `false`.
  - `readFindings(dir)` → array.

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findingKey,
  recordFinding,
  blocksGate,
  readFindings,
} from './ledger.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'sim-ld-'));
const base = {
  category: 'bug',
  severity: 'critical',
  status: 'confirmed',
  summary: 'Double credit on topup retry',
  endpoints: ['/store/credits/topup'],
};

test('same defect reported twice dedupes to one row', () => {
  const d = dir();
  assert.equal(recordFinding(d, base).added, true);
  assert.equal(
    recordFinding(d, { ...base, summary: 'double  CREDIT on Topup   retry' })
      .added,
    false,
  );
  assert.equal(readFindings(d).length, 1);
});

test('key ignores endpoint order', () => {
  const a = findingKey({ ...base, endpoints: ['/a', '/b'] });
  const b = findingKey({ ...base, endpoints: ['/b', '/a'] });
  assert.equal(a, b);
});

test('gate blocks only confirmed high/critical bugs and missing-capabilities', () => {
  assert.equal(blocksGate(base), true);
  assert.equal(blocksGate({ ...base, severity: 'medium' }), false);
  assert.equal(blocksGate({ ...base, status: 'unverified' }), false);
  assert.equal(blocksGate({ ...base, category: 'ux-friction' }), false);
  assert.equal(
    blocksGate({ ...base, category: 'missing-capability', severity: 'high' }),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/ledger.test.mjs`
Expected: FAIL — `Cannot find module './ledger.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/ledger.mjs
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

const fileOf = (dir) => join(dir, 'findings.jsonl');
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export function findingKey(f) {
  const eps = [...(f.endpoints ?? [])].sort().join(',');
  return `${f.category}|${eps}|${norm(f.summary)}`;
}

export function readFindings(dir) {
  const path = fileOf(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function recordFinding(dir, f) {
  mkdirSync(dir, { recursive: true });
  const key = findingKey(f);
  if (readFindings(dir).some((x) => findingKey(x) === key))
    return { added: false, key };
  const fd = openSync(fileOf(dir), 'a');
  try {
    writeSync(fd, JSON.stringify({ ...f, key }) + '\n');
  } finally {
    closeSync(fd);
  }
  return { added: true, key };
}

export function blocksGate(f) {
  return (
    f.status === 'confirmed' &&
    (f.category === 'bug' || f.category === 'missing-capability') &&
    (f.severity === 'critical' || f.severity === 'high')
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/ledger.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add -f scripts/sim/ledger.mjs scripts/sim/ledger.test.mjs
git commit -m "feat(sim): findings ledger with dedup and gate rule"
```

---

### Task 5: Time-shift SQL builder

**Files:**

- Create: `scripts/sim/time-shift.mjs`
- Test: `scripts/sim/time-shift.test.mjs`

**Interfaces:**

- Consumes: `SIM.TIME_SHIFT_TARGETS` from `config.mjs`.
- Produces: `buildShiftSql(targets, days = 1)` → array of SQL strings. `timestamp` kind → subtract `INTERVAL 'N day'`; `textday` kind → re-derive the `YYYY-MM-DD` string N days earlier via `to_date`/`to_char`, skipping rows that don't match the date pattern. Pure — no DB access.

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/time-shift.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShiftSql } from './time-shift.mjs';

const targets = [
  { table: 'credit_transaction', column: 'created_at', kind: 'timestamp' },
  { table: 'reward_draw', column: 'draw_day', kind: 'textday' },
];

test('timestamp column shifts back by an interval', () => {
  const [sql] = buildShiftSql(targets, 1);
  assert.match(
    sql,
    /UPDATE "credit_transaction" SET "created_at" = "created_at" - INTERVAL '1 day'/,
  );
});

test('textday column is re-derived as a shifted YYYY-MM-DD string', () => {
  const sql = buildShiftSql(targets, 1)[1];
  assert.match(
    sql,
    /"draw_day" = to_char\(\(to_date\("draw_day", 'YYYY-MM-DD'\) - 1\), 'YYYY-MM-DD'\)/,
  );
  assert.match(sql, /WHERE "draw_day" ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/);
});

test('one statement per target', () => {
  assert.equal(buildShiftSql(targets, 3).length, 2);
  assert.match(buildShiftSql(targets, 3)[0], /INTERVAL '3 day'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/time-shift.test.mjs`
Expected: FAIL — `Cannot find module './time-shift.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/time-shift.mjs
// Build the UPDATE statements that move a day of state back so time-gated
// features (daily draw, VIP/commission accrual) re-fire. The daily draw keys
// on a TEXT day column, so a timestamp-only shift is not enough — hence the
// two kinds. Pure string builder; time-shift-exec.mjs runs these via psql.
export function buildShiftSql(targets, days = 1) {
  const n = Number(days);
  return targets.map((t) => {
    if (t.kind === 'textday') {
      return (
        `UPDATE "${t.table}" SET "${t.column}" = ` +
        `to_char((to_date("${t.column}", 'YYYY-MM-DD') - ${n}), 'YYYY-MM-DD') ` +
        `WHERE "${t.column}" ~ '^\\d{4}-\\d{2}-\\d{2}$';`
      );
    }
    return `UPDATE "${t.table}" SET "${t.column}" = "${t.column}" - INTERVAL '${n} day';`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/time-shift.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add -f scripts/sim/time-shift.mjs scripts/sim/time-shift.test.mjs
git commit -m "feat(sim): time-shift SQL builder (timestamp + text-day columns)"
```

---

### Task 6: Store client (customer HTTP)

**Files:**

- Create: `scripts/sim/store-client.mjs`
- Test: `scripts/sim/store-client.test.mjs`

**Interfaces:**

- Consumes: `SIM.backendUrl`.
- Produces: `makeStoreClient({ baseUrl, publishableKey, token, fetchImpl })` → object with `register(email,password)`, `login(email,password)`, `topup(amount, idempotencyKey)`, `openPack(slug)`, `getCredits()`, `getVault()`, `buyback(vaultId)`, `requestDelivery(items)`. Each returns `{ status, body }`. Injectable `fetchImpl` defaults to global `fetch`. `topup` sends the `Idempotency-Key` header; store calls send `x-publishable-api-key`; authed calls send `Authorization: Bearer <token>`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/store-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStoreClient } from './store-client.mjs';

function recorder(status = 200, body = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('topup sends amount, idempotency key, publishable key and bearer token', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk_1',
    token: 'tok',
    fetchImpl,
  });
  const res = await c.topup(50, 'idem-1');
  assert.equal(res.status, 200);
  const { url, opts } = calls[0];
  assert.equal(url, 'http://h/store/credits/topup');
  assert.equal(opts.headers['Idempotency-Key'], 'idem-1');
  assert.equal(opts.headers['x-publishable-api-key'], 'pk_1');
  assert.equal(opts.headers['Authorization'], 'Bearer tok');
  assert.deepEqual(JSON.parse(opts.body), { amount: 50 });
});

test('openPack targets the slug open route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    token: 't',
    fetchImpl,
  });
  await c.openPack('starter-pack');
  assert.equal(calls[0].url, 'http://h/store/packs/starter-pack/open');
  assert.equal(calls[0].opts.method, 'POST');
});

test('login returns the parsed body so the caller can read the token', async () => {
  const { fetchImpl } = recorder(200, { token: 'jwt-xyz' });
  const c = makeStoreClient({
    baseUrl: 'http://h',
    publishableKey: 'pk',
    fetchImpl,
  });
  const res = await c.login('a@b.co', 'pw');
  assert.equal(res.body.token, 'jwt-xyz');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/store-client.test.mjs`
Expected: FAIL — `Cannot find module './store-client.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/store-client.mjs
// Thin customer-side HTTP client. Every method returns { status, body } so
// agents (and the auditor's repro replay) can assert on exact responses.
export function makeStoreClient({
  baseUrl,
  publishableKey,
  token,
  fetchImpl = fetch,
}) {
  const headers = (extra = {}) => ({
    'Content-Type': 'application/json',
    ...(publishableKey ? { 'x-publishable-api-key': publishableKey } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function call(method, path, { body, extraHeaders } = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: headers(extraHeaders),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  return {
    register: (email, password) =>
      call('POST', '/auth/customer/emailpass/register', {
        body: { email, password },
      }),
    login: (email, password) =>
      call('POST', '/auth/customer/emailpass', { body: { email, password } }),
    topup: (amount, idempotencyKey) =>
      call('POST', '/store/credits/topup', {
        body: { amount },
        extraHeaders: { 'Idempotency-Key': idempotencyKey },
      }),
    openPack: (slug) => call('POST', `/store/packs/${slug}/open`, { body: {} }),
    getCredits: () => call('GET', '/store/credits'),
    getVault: () => call('GET', '/store/vault'),
    buyback: (vaultId) =>
      call('POST', `/store/vault/${vaultId}/buyback`, { body: {} }),
    requestDelivery: (items) =>
      call('POST', '/store/delivery-orders', { body: { items } }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/store-client.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add -f scripts/sim/store-client.mjs scripts/sim/store-client.test.mjs
git commit -m "feat(sim): customer store HTTP client"
```

---

### Task 7: Admin client (admin HTTP)

**Files:**

- Create: `scripts/sim/admin-client.mjs`
- Test: `scripts/sim/admin-client.test.mjs`

**Interfaces:**

- Produces: `makeAdminClient({ baseUrl, token, fetchImpl })` → `login(email,password)`, `getCustomerTransactions(id)`, `adjustCredits(id, amount, reason)`, `freeze(id, reason)`, `unfreeze(id)`, `getDeliveryOrder(id)`, `updateDeliveryOrder(id, patch)`, `reverseCommission(id, reason)`. Returns `{ status, body }`. Authed calls send `Authorization: Bearer <token>`. **No publishable key** (admin API). The client has no method for operations the API lacks — a missing method is itself the signal to file a `missing-capability` finding.

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/admin-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAdminClient } from './admin-client.mjs';

function recorder(status = 200, body = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => (
      calls.push({ url, opts }),
      { status, json: async () => body }
    ),
  };
}

test('adjustCredits posts amount + reason to the customer credits route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.adjustCredits('cus_1', -25, 'refund: pack DOA');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_1/credits');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer adm');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    amount: -25,
    reason: 'refund: pack DOA',
  });
});

test('freeze hits the freeze sub-route', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.freeze('cus_2', 'chargeback');
  assert.equal(calls[0].url, 'http://h/admin/customers/cus_2/freeze');
  assert.equal(calls[0].opts.method, 'POST');
});

test('admin client sends no publishable key header', async () => {
  const { fetchImpl, calls } = recorder();
  const c = makeAdminClient({ baseUrl: 'http://h', token: 'adm', fetchImpl });
  await c.getCustomerTransactions('cus_3');
  assert.equal(calls[0].opts.headers['x-publishable-api-key'], undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/admin-client.test.mjs`
Expected: FAIL — `Cannot find module './admin-client.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/admin-client.mjs
// Admin-side HTTP client. Deliberately narrow: it exposes ONLY operations the
// real admin API supports. When the admin agent needs something with no method
// here, that gap is a `missing-capability` finding — not a reason to reach past
// the API. Routes verified under src/api/admin/.
export function makeAdminClient({ baseUrl, token, fetchImpl = fetch }) {
  const headers = () => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function call(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  return {
    login: (email, password) =>
      call('POST', '/auth/user/emailpass', { email, password }),
    getCustomerTransactions: (id) =>
      call('GET', `/admin/customers/${id}/transactions`),
    adjustCredits: (id, amount, reason) =>
      call('POST', `/admin/customers/${id}/credits`, { amount, reason }),
    freeze: (id, reason) =>
      call('POST', `/admin/customers/${id}/freeze`, { reason }),
    unfreeze: (id) => call('POST', `/admin/customers/${id}/unfreeze`, {}),
    getDeliveryOrder: (id) => call('GET', `/admin/delivery-orders/${id}`),
    updateDeliveryOrder: (id, patch) =>
      call('POST', `/admin/delivery-orders/${id}`, patch),
    reverseCommission: (id, reason) =>
      call('POST', `/admin/commissions/${id}/reverse`, { reason }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/admin-client.test.mjs`
Expected: PASS (3/3).

> Note for the executor: the exact admin credit/freeze request bodies are verified against `src/api/admin/customers/[id]/credits/route.ts` and `.../freeze/route.ts` during the pilot (Task 11). If a body field differs, fix the client method and its test together — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add -f scripts/sim/admin-client.mjs scripts/sim/admin-client.test.mjs
git commit -m "feat(sim): admin HTTP client (API-only, gaps are findings)"
```

---

### Task 8: Live viewer server (SSE tail)

**Files:**

- Create: `scripts/sim/viewer.mjs`
- Test: `scripts/sim/viewer.test.mjs`

**Interfaces:**

- Consumes: `SIM.viewerPort`, `runDir`, `readEvents`.
- Produces: `startViewer({ dir, port })` → `{ url, close() }`. Serves `GET /` (the HTML page) and `GET /events` (SSE stream that replays existing events then pushes new ones as `events.jsonl` grows). Polls the file (200ms) — no fs.watch (unreliable cross-platform for appends).

- [ ] **Step 1: Write the failing test**

```js
// scripts/sim/viewer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent } from './event-log.mjs';
import { startViewer } from './viewer.mjs';

test('GET / serves the canvas page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-vw-'));
  const v = startViewer({ dir, port: 0 });
  try {
    const res = await fetch(v.url + '/');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<canvas/i);
  } finally {
    v.close();
  }
});

test('SSE stream replays an existing event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-vw-'));
  appendEvent(dir, { day: 1, actor: 'honest', kind: 'arrived' });
  const v = startViewer({ dir, port: 0 });
  try {
    const res = await fetch(v.url + '/events');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /"kind":"arrived"/);
    await reader.cancel();
  } finally {
    v.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/sim/viewer.test.mjs`
Expected: FAIL — `Cannot find module './viewer.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/sim/viewer.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEvents } from './event-log.mjs';
import { SIM } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function startViewer({ dir, port = SIM.viewerPort }) {
  const page = readFileSync(join(HERE, 'viewer.html'), 'utf8');

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.url.startsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let sent = 0;
      const flush = () => {
        const all = readEvents(dir);
        for (; sent < all.length; sent++)
          res.write(`data: ${JSON.stringify(all[sent])}\n\n`);
      };
      flush();
      const timer = setInterval(flush, 200);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port);
  const actualPort = server.address().port;
  return { url: `http://localhost:${actualPort}`, close: () => server.close() };
}

// Allow `node scripts/sim/viewer.mjs <runId>` to open a standalone viewer.
if (process.argv[1] && process.argv[1].endsWith('viewer.mjs')) {
  const runId = process.argv[2];
  if (!runId) {
    console.error('usage: node scripts/sim/viewer.mjs <runId>');
    process.exit(1);
  }
  const { runDir } = await import('./config.mjs');
  const v = startViewer({ dir: runDir(runId) });
  console.log(`viewer: ${v.url}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/sim/viewer.test.mjs`
Expected: FAIL — `viewer.html` does not exist yet (`ENOENT`). Proceed to Step 5, then re-run.

- [ ] **Step 5: Create a minimal `viewer.html` so the server can boot**

Create `scripts/sim/viewer.html` with a placeholder body (Task 9 replaces it with the full renderer):

```html
<!doctype html>
<meta charset="utf-8" />
<title>PixelSlot — Live Sim</title>
<canvas id="floor" width="640" height="360"></canvas>
<script>
  /* replaced in Task 9 */
</script>
```

- [ ] **Step 6: Re-run the test**

Run: `node --test scripts/sim/viewer.test.mjs`
Expected: PASS (2/2).

- [ ] **Step 7: Commit**

```bash
git add -f scripts/sim/viewer.mjs scripts/sim/viewer.test.mjs scripts/sim/viewer.html
git commit -m "feat(sim): zero-dep SSE viewer server tailing events.jsonl"
```

---

### Task 9: Viewer page — pixel arcade floor + data sidebar

**Files:**

- Modify: `scripts/sim/viewer.html` (full replacement)

**Interfaces:**

- Consumes: the SSE `/events` stream (each `data:` line is one event record).
- Produces: no exports — a browser page. Renders sprites (one per persona), tweens them toward `targetFor(event)`, draws slot machines/vault/desk, shows an admin queue, and a sidebar with day counter, per-persona balance/action, queue depth, and a severity-colored findings feed.

This task has no unit test (it is canvas rendering). Verification is the smoke check in Step 3 and, end-to-end, the pilot in Task 11.

- [ ] **Step 1: Replace `scripts/sim/viewer.html` with the full renderer**

```html
<!doctype html>
<meta charset="utf-8" />
<title>PixelSlot — Live Sim</title>
<style>
  :root {
    color-scheme: dark;
  }
  * {
    margin: 0;
    box-sizing: border-box;
  }
  body {
    background: #0a0a0a;
    color: #fafafa;
    font:
      13px/1.4 ui-monospace,
      monospace;
    display: flex;
    height: 100vh;
  }
  #stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  canvas {
    image-rendering: pixelated;
    background: #141414;
    border: 1px solid #262626;
    width: min(96%, 900px);
  }
  #side {
    width: 320px;
    border-left: 1px solid #262626;
    padding: 12px;
    overflow-y: auto;
  }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #a3a3a3;
    margin: 14px 0 6px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 6px;
  }
  #findings .f {
    padding: 4px 6px;
    margin: 3px 0;
    border-radius: 4px;
    background: #1c1c1c;
  }
  .sev-critical {
    border-left: 3px solid #ef4444;
  }
  .sev-high {
    border-left: 3px solid #f97316;
  }
  .sev-medium {
    border-left: 3px solid #eab308;
  }
  .sev-low {
    border-left: 3px solid #6b7280;
  }
  #day {
    font-size: 18px;
    font-weight: 700;
  }
</style>
<div id="stage"><canvas id="floor" width="640" height="360"></canvas></div>
<aside id="side">
  <div id="day">Day —</div>
  <h2>Customers</h2>
  <div id="customers"></div>
  <h2>Admin queue (<span id="qdepth">0</span>)</h2>
  <div id="queue"></div>
  <h2>Findings</h2>
  <div id="findings"></div>
</aside>
<script type="module">
  // Choreography is duplicated here (browser can't import the .mjs across the
  // SSE boundary without a bundler; the map is tiny). Keep in sync with
  // choreography.mjs — the pilot checks a played_pack lands a sprite on a slot.
  const STATIONS = {
    entrance: { x: 40, y: 180 },
    slot1: { x: 200, y: 70 },
    slot2: { x: 200, y: 180 },
    slot3: { x: 200, y: 290 },
    vault: { x: 360, y: 70 },
    desk: { x: 500, y: 180 },
  };
  function targetFor(e) {
    switch (e.kind) {
      case 'played_pack':
        return {
          ...(STATIONS[e.detail?.slot] || STATIONS.slot1),
          mood: 'busy',
        };
      case 'pull_result':
        return {
          ...STATIONS.slot1,
          mood: e.detail?.rarity === 'legendary' ? 'happy' : 'neutral',
        };
      case 'complained':
        return { ...STATIONS.desk, mood: 'angry' };
      case 'admin_picked_up':
      case 'admin_resolved':
        return { ...STATIONS.desk, mood: 'busy' };
      default:
        return { ...STATIONS.entrance, mood: 'neutral' };
    }
  }
  const MOOD = {
    neutral: '#e5e5e5',
    happy: '#4ade80',
    angry: '#ef4444',
    busy: '#38bdf8',
  };

  const cvs = document.getElementById('floor');
  const ctx = cvs.getContext('2d');
  const sprites = new Map(); // actor -> { x, y, tx, ty, color, mood, action }
  const queue = []; // customer ids waiting at the desk
  const balances = new Map();
  let day = 0;

  const COLORS = {}; // actor -> color, assigned on first sight
  const PALETTE = [
    '#4ade80',
    '#f87171',
    '#a78bfa',
    '#fbbf24',
    '#38bdf8',
    '#fb923c',
    '#f472b6',
    '#2dd4bf',
  ];
  let ci = 0;
  const colorOf = (a) => (COLORS[a] ??= PALETTE[ci++ % PALETTE.length]);

  function handle(e) {
    if (typeof e.day === 'number') {
      day = e.day;
      document.getElementById('day').textContent = 'Day ' + day;
    }
    if (e.kind === 'finding') {
      addFinding(e.detail);
      return;
    }
    if (e.actor === 'admin') {
      if (e.kind === 'admin_picked_up' && e.detail?.customer) {
        const i = queue.indexOf(e.detail.customer);
        if (i >= 0) queue.splice(i, 1);
      }
      renderQueue();
      return;
    }
    if (e.kind === 'complained' && !queue.includes(e.actor))
      queue.push(e.actor);
    if (e.detail?.balance != null) balances.set(e.actor, e.detail.balance);
    const t = targetFor(e);
    const s = sprites.get(e.actor) || {
      x: STATIONS.entrance.x,
      y: STATIONS.entrance.y,
      color: colorOf(e.actor),
    };
    s.tx = t.x;
    s.ty = t.y;
    s.mood = t.mood;
    s.action = e.kind;
    sprites.set(e.actor, s);
    renderQueue();
    renderCustomers();
  }

  function addFinding(f) {
    const el = document.createElement('div');
    el.className = 'f sev-' + (f?.severity || 'low');
    el.textContent = `[${f?.category || '?'}] ${f?.summary || ''}`;
    document.getElementById('findings').prepend(el);
  }
  function renderQueue() {
    document.getElementById('qdepth').textContent = queue.length;
    document.getElementById('queue').innerHTML = queue
      .map(
        (a) =>
          `<div class="row"><span><span class="dot" style="background:${colorOf(a)}"></span>${a}</span></div>`,
      )
      .join('');
  }
  function renderCustomers() {
    document.getElementById('customers').innerHTML = [...sprites.entries()]
      .map(
        ([a, s]) =>
          `<div class="row"><span><span class="dot" style="background:${s.color}"></span>${a}</span><span>${balances.get(a) ?? '—'} · ${s.action || ''}</span></div>`,
      )
      .join('');
  }

  function draw() {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    // stations
    ctx.fillStyle = '#262626';
    for (const k of ['slot1', 'slot2', 'slot3'])
      rect(STATIONS[k], 26, 34, '#3b3b3b');
    rect(STATIONS.vault, 30, 30, '#3f3f46');
    rect(STATIONS.desk, 40, 26, '#404040');
    label(STATIONS.vault, 'VAULT');
    label(STATIONS.desk, 'ADMIN');
    // sprites
    for (const s of sprites.values()) {
      s.x += ((s.tx ?? s.x) - s.x) * 0.12;
      s.y += ((s.ty ?? s.y) - s.y) * 0.12;
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
      ctx.fillStyle = MOOD[s.mood] || '#e5e5e5';
      ctx.fillRect(s.x - 5, s.y - 9, 10, 3);
    }
    requestAnimationFrame(draw);
  }
  function rect(p, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
  }
  function label(p, t) {
    ctx.fillStyle = '#a3a3a3';
    ctx.font = '9px monospace';
    ctx.fillText(t, p.x - 14, p.y + 26);
  }

  const es = new EventSource('/events');
  es.onmessage = (m) => {
    try {
      handle(JSON.parse(m.data));
    } catch {}
  };
  requestAnimationFrame(draw);
</script>
```

- [ ] **Step 2: Regression — the server test still passes**

Run: `node --test scripts/sim/viewer.test.mjs`
Expected: PASS (2/2) — the page still contains `<canvas` and the SSE route is unchanged.

- [ ] **Step 3: Manual smoke check**

```bash
node -e "import('./scripts/sim/event-log.mjs').then(async ({appendEvent})=>{const d='scripts/sim/runs/smoke';appendEvent(d,{day:1,actor:'honest',kind:'arrived'});appendEvent(d,{day:1,actor:'refund-seeker',kind:'complained'});appendEvent(d,{day:1,actor:'auditor',kind:'finding',detail:{category:'bug',severity:'critical',summary:'demo finding'}});})"
node scripts/sim/viewer.mjs smoke
```

Open `http://localhost:4500`. Expected: two sprites (one drifts to the desk), admin queue shows `refund-seeker`, findings feed shows a red "demo finding". Ctrl-C to stop. Then remove the smoke dir: `rm -rf scripts/sim/runs/smoke`.

- [ ] **Step 4: Commit**

```bash
git add -f scripts/sim/viewer.html
git commit -m "feat(sim): arcade-floor canvas viewer with data sidebar"
```

---

### Task 10: Provision + time-shift executor (integration script)

**Files:**

- Create: `scripts/sim/provision.mjs`
- Create: `scripts/sim/time-shift-exec.mjs`

**Interfaces:**

- Consumes: `SIM`, `simDatabaseUrl`, `buildShiftSql`, `SIM.TIME_SHIFT_TARGETS`; `process.env.DATABASE_URL` (never printed), `REDIS_URL`.
- Produces:
  - `provision.mjs` — CLI: drops+creates `pixelslot_sim` via `docker exec pokenic-postgres psql`, runs `corepack yarn medusa db:migrate` + `seed.ts` + `print-publishable-key.ts` against `DATABASE_URL=<sim url>` with `ALLOW_MOCK_TOPUP=true`, and writes the captured publishable key token to `scripts/sim/runs/<runId>/pk.txt`.
  - `time-shift-exec.mjs` — exports `shiftDay(days=1)`: runs `buildShiftSql` statements via `psql` against the sim DB and flushes Redis index 9 (`redis-cli -n 9 flushdb` via `docker exec pokenic-redis`).

These are integration glue (no pure logic to unit-test). Verified by running them in Task 11.

- [ ] **Step 1: Write `provision.mjs`**

```js
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
```

- [ ] **Step 2: Write `time-shift-exec.mjs`**

```js
// scripts/sim/time-shift-exec.mjs
import { execFileSync } from 'node:child_process';
import { SIM } from './config.mjs';
import { buildShiftSql } from './time-shift.mjs';

export function shiftDay(days = 1) {
  const sql = buildShiftSql(SIM.TIME_SHIFT_TARGETS, days).join('\n');
  execFileSync(
    'docker',
    [
      'exec',
      'pokenic-postgres',
      'psql',
      '-U',
      'postgres',
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
  shiftDay(Number(process.argv[2] || 1));
  console.log('[sim] shifted day');
}
```

- [ ] **Step 3: Static sanity (no live run yet)**

Run: `node --check scripts/sim/provision.mjs && node --check scripts/sim/time-shift-exec.mjs`
Expected: no output, exit 0 (syntax valid). The live run happens in Task 11.

> Note: `psql -U postgres` assumes the container's superuser. If the pilot shows a different role, the executor updates the `-U` value in both files (one line each). The DB _password_ is never passed on the command line — `docker exec` into the container authenticates via local trust; if the pilot proves otherwise, use `PGPASSWORD` via the `env` option (still never echoed).

- [ ] **Step 4: Commit**

```bash
git add -f scripts/sim/provision.mjs scripts/sim/time-shift-exec.mjs
git commit -m "feat(sim): DB provision + day time-shift executor"
```

---

### Task 11: Persona charters + workflow day-loop + 2-day pilot (integration gate)

**Files:**

- Create: `scripts/sim/personas/honest.md`
- Create: `scripts/sim/personas/refund-seeker.md`
- Create: `scripts/sim/personas/admin.md`
- Create: `scripts/sim/personas/auditor.md`
- Create: `scripts/sim/run-month.workflow.mjs`
- Create: `scripts/sim/PILOT.md` (runbook)

**Interfaces:**

- Consumes: every prior module (`config`, `event-log`, `ledger`, `store-client`, `admin-client`, `time-shift-exec`, `viewer`).
- Produces: a Workflow script (run via the Workflow tool's `scriptPath`) that, for `args.days` days, spawns customer agents → admin agent → auditor agent (Opus), appends their events, records findings, and calls `shiftDay(1)` between days. The 2-day pilot proves the whole loop before any 30-day run.

- [ ] **Step 1: Write the persona charters**

`scripts/sim/personas/honest.md` (the others follow the same shape — write each fully, do not cross-reference):

```md
# Persona: Honest customer (control)

You are a normal PixelSlot customer for one simulated day. You act ONLY via HTTP
against the store API using the client in scripts/sim/store-client.mjs. Your
publishable key is in runs/<runId>/pk.txt; your account + token are in your diary
(runs/<runId>/diary/honest.md). If the diary has no account, register one, then
log in.

A normal day: check your credit balance; if low, top up a sensible amount (never
an amount ending in .13); open one or two packs; look at your vault. If anything
returns a non-2xx you did not expect, note it in your diary AND emit a `finding`
event via appendEvent with a real request/response repro.

After acting, append today's events (arrived, played_pack, pull_result with the
rarity, left) to events.jsonl via scripts/sim/event-log.mjs, and append a diary
entry: balance, what you did, anything you are waiting on.

Return a short JSON summary: { actor, actions: string[], suspectedFindings: [...] }.
Do NOT invent events you did not actually cause via a real HTTP call.
```

`scripts/sim/personas/refund-seeker.md`:

```md
# Persona: Refund seeker (adversarial)

You are an aggressive PixelSlot customer who wants money back. Act ONLY via HTTP.
Read your diary (runs/<runId>/diary/refund-seeker.md) for your account, token,
grudges, and open requests. If yesterday you were refused, escalate today.

Tactics: open a pack then demand a refund via the support inbox (append a message
to runs/<runId>/inbox.jsonl: { day, from:'refund-seeker', kind:'refund_request',
detail }); dispute buyback prices; claim a pack was "never delivered"; try to get
credit back AND keep the pulled card. Emit a `complained` event when you escalate
to the desk.

Every real defect (an endpoint that lets you double-dip, a refund with no audit
trail) → emit a `finding` event with the exact repro. A demand that is correctly
refused is NOT a finding. Append your events + diary entry. Return the JSON summary.
```

`scripts/sim/personas/admin.md`:

```md
# Persona: Admin operator

You run PixelSlot support for one simulated day. Act ONLY via the admin API
(scripts/sim/admin-client.mjs); your admin token is in your diary. Read
runs/<runId>/inbox.jsonl for open customer requests, oldest first.

For each request: pick it up (emit `admin_picked_up` with the customer id), pull
the customer's transactions to adjudicate, and resolve it with a REAL admin
endpoint (credit adjustment with a reason, freeze on a chargeback, delivery
update). Emit `admin_resolved` when done and reply in inbox.jsonl.

BINDING RULE: no workarounds, no direct DB edits, no pretending. If the API cannot
do what the situation needs (e.g. there is no partial-refund endpoint, no way to
see why a pull double-charged, no reship), STOP, tell the customer no in the inbox,
and emit a `finding` (category `missing-capability` or `ux-friction`) with what you
needed and which endpoint was missing. Append a case-log diary entry. Return the
JSON summary of tickets worked and findings filed.
```

`scripts/sim/personas/auditor.md`:

```md
# Persona: Auditor (verifier, acts on nothing)

You verify the day. You do NOT act in the store. Read events.jsonl, inbox.jsonl,
and every persona's suspectedFindings for today.

1. Invariants: sum each customer's credit ledger equals their reported balance;
   no negative balances; every inbox request is resolved or has a `finding`.
   Pack pulls are random — assert the balance fell by exactly the pack price,
   never a specific card.
2. Verify each suspected finding by RE-EXECUTING its repro via the store/admin
   client. Only if you reproduce it does it become `status:'confirmed'`; otherwise
   record it `status:'unverified'`. Infra errors (ECONNREFUSED, pool timeout, a
   429 on normal use) are NOT findings — drop them.
3. Record confirmed/unverified findings via recordFinding (it dedupes). Write a
   one-paragraph day summary to runs/<runId>/day-<N>.md.

Return: { day, invariantsPassed: boolean, confirmed: n, unverified: n, showstopper: boolean }.
Set showstopper=true only if a defect invalidates all later days (e.g. every
balance is corrupt).
```

- [ ] **Step 2: Write the workflow day-loop**

```js
// scripts/sim/run-month.workflow.mjs
export const meta = {
  name: 'virtual-month-sim',
  description:
    'Run the adversarial virtual-month simulation against the sim backend',
  phases: [{ title: 'Day' }],
};

// args: { runId, days, activePersonas?: string[] }
const runId = args?.runId;
const days = args?.days ?? 2;
if (!runId) throw new Error('args.runId is required');

const CUSTOMERS = args?.activePersonas ?? ['honest', 'refund-seeker'];

for (let day = 1; day <= days; day++) {
  phase('Day');
  log(`Day ${day} — customers acting`);

  // Customers act concurrently (cap 4 — Knex pool). Each returns its summary.
  const customerSummaries = await parallel(
    CUSTOMERS.map(
      (p) => () =>
        agent(customerPrompt(p, runId, day), {
          label: `cust:${p}:d${day}`,
          phase: 'Day',
          model: 'opus',
        }),
    ),
  );

  log(`Day ${day} — admin working the inbox`);
  const adminSummary = await agent(adminPrompt(runId, day), {
    label: `admin:d${day}`,
    phase: 'Day',
    model: 'opus',
  });

  log(`Day ${day} — auditor closing the day`);
  const audit = await agent(auditorPrompt(runId, day), {
    label: `audit:d${day}`,
    phase: 'Day',
    model: 'opus',
    schema: AUDIT_SCHEMA,
  });

  if (audit?.showstopper) {
    log(`Day ${day} — SHOWSTOPPER declared; pausing the run for a hotfix`);
    return { stoppedAt: day, reason: 'showstopper', audit };
  }

  if (day < days) {
    log(`Day ${day} — time-shifting the world back one day`);
    const { shiftDay } = await import('./time-shift-exec.mjs');
    shiftDay(1);
  }
}

return { runId, days, complete: true };

// --- prompt builders: each reads the charter file and pins the run context ---
function base(runId, day) {
  return `Run id: ${runId}. Simulated day: ${day}. Artifacts under scripts/sim/runs/${runId}/. Backend: http://localhost:9000. Publishable key: read runs/${runId}/pk.txt.`;
}
function customerPrompt(p, runId, day) {
  return `${base(runId, day)}\n\nFollow your charter exactly: scripts/sim/personas/${p}.md`;
}
function adminPrompt(runId, day) {
  return `${base(runId, day)}\n\nFollow your charter exactly: scripts/sim/personas/admin.md`;
}
function auditorPrompt(runId, day) {
  return `${base(runId, day)}\n\nFollow your charter exactly: scripts/sim/personas/auditor.md`;
}
const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'day',
    'invariantsPassed',
    'confirmed',
    'unverified',
    'showstopper',
  ],
  properties: {
    day: { type: 'integer' },
    invariantsPassed: { type: 'boolean' },
    confirmed: { type: 'integer' },
    unverified: { type: 'integer' },
    showstopper: { type: 'boolean' },
  },
};
```

- [ ] **Step 3: Write the pilot runbook**

```md
# scripts/sim/PILOT.md — 2-day pilot runbook

Prove the harness end-to-end before any 30-day run.

## Preconditions

- Docker containers up: `docker ps` shows pokenic-postgres, pokenic-redis.
- Backend env available: `DATABASE_URL` exported in the shell (source backend/packages/api env; do NOT print it).

## Steps

1. `npm run sim:test` → all unit tests green.
2. `node scripts/sim/provision.mjs pilot` → recreates pixelslot_sim, seeds, writes runs/pilot/pk.txt.
3. Start the sim backend (built) on :9000 against the sim DB with ALLOW_MOCK_TOPUP=true:
   `cd backend/packages/api && DATABASE_URL=<sim url> ALLOW_MOCK_TOPUP=true corepack yarn build && DATABASE_URL=<sim url> ALLOW_MOCK_TOPUP=true corepack yarn start`
   Health: `curl -s localhost:9000/health` → ok.
4. Start the viewer: `node scripts/sim/viewer.mjs pilot` → open http://localhost:4500.
5. Run the loop via the Workflow tool: `Workflow({ scriptPath: 'scripts/sim/run-month.workflow.mjs', args: { runId: 'pilot', days: 2 } })`.

## Pass criteria (the gate for Phase 1)

- [ ] Both customers registered + acted; events.jsonl has arrived/played_pack for each.
- [ ] A refund_request reached inbox.jsonl and the admin either resolved it or filed a `missing-capability` finding.
- [ ] Day 1 daily draw succeeded; after `shiftDay(1)`, Day 2 daily draw succeeded again (proves the text-day shift works). If Day 2 is blocked "already drew today", add the missing column to SIM.TIME_SHIFT_TARGETS and re-run.
- [ ] Auditor produced day-1.md and day-2.md and at least ran invariants.
- [ ] Viewer showed sprites moving and (if any) a finding in the feed.
- [ ] No infra errors misfiled as findings.
```

- [ ] **Step 4: Static sanity of the workflow + charters present**

Run: `node --check scripts/sim/run-month.workflow.mjs && ls scripts/sim/personas/`
Expected: exit 0; lists `admin.md auditor.md honest.md refund-seeker.md`.

- [ ] **Step 5: Run the pilot**

Follow `scripts/sim/PILOT.md`. Work through the pass-criteria checklist. Fix any harness defect found (client body mismatch, psql role, missing time-shift column) by editing the relevant module + its unit test together, then re-run from the failed step. **Stop and report** if a pass criterion fails for a reason that is a _product_ gap (not a harness bug) — that is the simulation's first real finding.

- [ ] **Step 6: Commit**

```bash
git add -f scripts/sim/personas scripts/sim/run-month.workflow.mjs scripts/sim/PILOT.md
git commit -m "feat(sim): persona charters, workflow day-loop, and 2-day pilot runbook"
```

---

## Self-Review

**Spec coverage:**

- §2 world (sim DB, ALLOW_MOCK_TOPUP, seed, funding, time, rate limits) → Tasks 1, 10, 11.
- §3 cast (8 personas, admin, auditor) → Task 1 config + Task 11 charters (2 customer charters written in full as the pilot set; the remaining 6 follow the identical shape and are added when the run scales to 30 days — flagged below).
- §4 orchestration + memory (day loop, diaries, concurrency cap 4) → Task 11 workflow.
- §4b live viewer (semantic events, SSE tail, canvas floor, sidebar, strictly live) → Tasks 2, 8, 9.
- §5 findings ledger (schema, dedup, severity rubric) → Task 4.
- §6 fix phase, §7 cost/failure, §8 blind spots, §9 success → run-time protocol, not phase-1 code; encoded in charters (Task 11) and PILOT.md.
- §10 decomposition → this plan is phase 1 only, as stated.

**Known gap (intentional, not a placeholder):** only 2 of 8 customer charters are authored here because the pilot runs 2 customers. The other 6 (`exploit-hunter`, `newbie`, `high-roller`, `referral-schemer`, `impatient-shipper`, `buyback-haggler`) are written as a small follow-up before the first full 30-day run — each is one charter file of the same shape, no new code. This keeps the pilot cheap and avoids writing 6 charters that the pilot might prove need a different structure.

**Placeholder scan:** the only literal "replaced later" is `viewer.html`'s Task-8 stub, which Task 9 fully replaces — intentional and sequenced, not a dangling TODO.

**Type consistency:** `appendEvent`/`readEvents`, `findingKey`/`recordFinding`/`blocksGate`, `buildShiftSql`, `makeStoreClient`/`makeAdminClient`, `startViewer`, `shiftDay`, `simDatabaseUrl`/`runDir`/`SIM` are referenced with identical names across tasks. Event `kind` values match between `choreography.mjs`, `viewer.html`, and the charters.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-virtual-month-sim-harness.md`.
