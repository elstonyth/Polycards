/**
 * Source-scan seal: the ONLY place `.deleteCreditTransactions(` (the raw
 * MedusaService-generated base) may appear in src/ is the single delegation
 * call inside `deleteCreditTransactionsGuarded` in service.ts.
 *
 * This test fails CI if anyone routes a new delete around the guard, making it
 * the enforceable substitute for an ESLint ban (the backend api package has no
 * ESLint config — see task-11-report.md for why).
 */

import * as fs from 'fs';
import * as path from 'path';

// Re-anchored to src/ (not the api package root) so the scan walks only ~100
// source files instead of ~22k node_modules + integration-tests files.
const SRC_ROOT = path.resolve(__dirname, '../../../');

/** Recursively collect all .ts files under dir, skipping __tests__ dirs. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        results.push(...collectTsFiles(full));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

interface SourceHit {
  file: string;
  line: number;
  text: string;
}

test('the only raw .deleteCreditTransactions( call in src/ is the single delegation inside service.ts', () => {
  const files = collectTsFiles(SRC_ROOT);
  const occurrences: SourceHit[] = [];

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.includes('.deleteCreditTransactions(') &&
        !line.includes('deleteCreditTransactionsGuarded')
      ) {
        occurrences.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }

  // Exactly one raw call must exist: the delegation inside the guarded wrapper.
  expect(occurrences).toHaveLength(1);

  const [only] = occurrences;
  const rel = path.relative(SRC_ROOT, only.file).replace(/\\/g, '/');
  // Path is relative to SRC_ROOT (src/), so no leading "src/" prefix.
  expect(rel).toBe('modules/packs/service.ts');
});

// The per-customer credit lock key is built in ONE place (credit-posting.ts's
// creditLockKey): a hand-typed copy can drift from it, and a drifted key stops
// two money paths from excluding each other. Template and concatenation forms.
test('the credit: lock key is spelled only in modules/packs/credit-posting.ts', () => {
  const offenders: SourceHit[] = [];
  for (const file of collectTsFiles(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (/`credit:\$\{|['"]credit:['"]\s*\+/.test(text)) {
        offenders.push({ file: path.relative(SRC_ROOT, file).replace(/\\/g, '/'), line: i + 1, text: text.trim() });
      }
    });
  }
  expect(offenders.map((o) => o.file)).toEqual(['modules/packs/credit-posting.ts']);
});

// Every credit row is posted by mutateCreditAtomic (planPosting decides the
// row; credit-posting.ts): the lock, the bonus split, the replay check and the
// paired ledger row live there. So the ONE raw .createCreditTransactions( call
// in src/ is its insert — a second writer would pair rows by hand again.
test('the only .createCreditTransactions( call in src/ is mutateCreditAtomic\'s insert', () => {
  const found: SourceHit[] = [];
  for (const file of collectTsFiles(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (!text.includes('.createCreditTransactions(')) return;
      let method = i;
      while (method > 0 && !/^\s{2}(?:protected |private )?async \w+\(/.test(lines[method])) method--;
      found.push({
        file: path.relative(SRC_ROOT, file).replace(/\\/g, '/'),
        line: i + 1,
        text: (lines[method].match(/async (\w+)\(/) ?? [])[1] ?? text.trim(),
      });
    });
  }
  expect(found.map((o) => `${o.file} ${o.text}`)).toEqual(['modules/packs/service.ts mutateCreditAtomic']);
});
