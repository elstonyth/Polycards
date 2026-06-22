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

const SRC_ROOT = path.resolve(__dirname, '../../../../');

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

interface RawDeleteOccurrence {
  file: string;
  line: number;
  text: string;
}

test('the only raw .deleteCreditTransactions( call in src/ is the single delegation inside service.ts', () => {
  const files = collectTsFiles(SRC_ROOT);
  const occurrences: RawDeleteOccurrence[] = [];

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
  expect(rel).toBe('src/modules/packs/service.ts');
});
