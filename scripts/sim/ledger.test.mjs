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
