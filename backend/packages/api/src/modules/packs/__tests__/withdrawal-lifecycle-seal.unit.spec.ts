/**
 * Source-scan seal: every status write and every generated-updater write to a
 * gateway_withdrawal row goes through the Withdrawal lifecycle
 * (modules/packs/withdrawal-lifecycle.ts). Raw non-status writes exist
 * elsewhere on purpose (the A3Pay verify outcome, the account-number scrubs,
 * the audit acknowledgement); a raw write that sets `status` fails here.
 *
 * The generated `updateGatewayWithdrawals({ selector, data })` type-checks
 * and reads like a scoped guard, but it is a find-then-write with no row
 * lock. Three status writes used to go around the conditional claim that
 * way, safe only because ledger replay checks stopped a double refund. This
 * test fails CI if a raw write, or a direct claim, appears anywhere else.
 *
 * Modelled on delete-guard-seal.unit.spec.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../../');

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

/** `<file> <enclosing function>` for every line that calls `.method(`. */
function callSites(method: string): string[] {
  const found: string[] = [];
  const call = new RegExp(`\\.${method}\\s*\\(`);
  for (const file of collectTsFiles(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (!call.test(text)) return;
      let at = i;
      while (
        at > 0 &&
        !/^(?:export )?(?:async )?function \w+|^\s{2}(?:protected |private )?async \w+\(/.test(
          lines[at],
        )
      ) {
        at--;
      }
      const name =
        (lines[at].match(/function (\w+)|^\s*(?:\w+ )?async (\w+)\(/) ?? [])
          .slice(1)
          .find(Boolean) ?? '?';
      found.push(
        `${path.relative(SRC_ROOT, file).replace(/\\/g, '/')} ${name}`,
      );
    });
  }
  return found.sort();
}

test('only the Withdrawal lifecycle (and the claim adapter inside service.ts) writes gateway_withdrawal through the generated updater', () => {
  // The positive control is the lifecycle file itself: a broken scan would
  // find nothing and must not pass.
  expect(callSites('updateGatewayWithdrawals')).toEqual([
    // The bigNumber half of a won claim, on the claim's own transaction.
    'modules/packs/service.ts writeSettlementMirror',
    'modules/packs/withdrawal-lifecycle.ts stampPendingWithdrawal',
    'modules/packs/withdrawal-lifecycle.ts stampWithdrawalAudit',
  ]);
});

test('a withdrawal status is claimed only through the Withdrawal lifecycle', () => {
  expect(callSites('claimWithdrawalStatus')).toEqual([
    // Under the credit: lock, on the same transaction as the debit read.
    'modules/packs/service.ts claimWithdrawalAgainstDebit',
    'modules/packs/withdrawal-lifecycle.ts failWithdrawal',
    'modules/packs/withdrawal-lifecycle.ts settleWithdrawal',
  ]);
  expect(callSites('claimWithdrawalAgainstDebit')).toEqual([
    'modules/packs/withdrawal-lifecycle.ts claimHeldWithdrawal',
  ]);
});

/** Source text with comments removed: a comment may name the updater. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const rel = (file: string) =>
  path.relative(SRC_ROOT, file).replace(/\\/g, '/');

// The dotted-call scan above misses `packs['updateGatewayWithdrawals']`, a
// destructure, or a method reference passed along. Any mention outside a
// comment counts here.
test('the generated updater is named only by the facet, the claim adapter and the lifecycle', () => {
  const mentions: Record<string, number> = {};
  for (const file of collectTsFiles(SRC_ROOT)) {
    const n = (code(file).match(/\bupdateGatewayWithdrawals\b/g) ?? []).length;
    if (n > 0) mentions[rel(file)] = n;
  }
  expect(Object.keys(mentions).sort()).toEqual([
    'modules/packs/facets.ts',
    'modules/packs/service.ts',
    'modules/packs/withdrawal-lifecycle.ts',
  ]);
  // The facet's type member, and writeSettlementMirror's one call.
  expect(mentions['modules/packs/facets.ts']).toBe(1);
  expect(mentions['modules/packs/service.ts']).toBe(1);
});

test('no raw SQL sets a withdrawal status', () => {
  const offenders: string[] = [];
  const update = /update\s+"?gateway_withdrawal"?\s+set\b((?:(?!\bwhere\b)[\s\S])*)/gi;
  for (const file of collectTsFiles(SRC_ROOT)) {
    for (const [, setClause] of code(file).matchAll(update)) {
      if (/\bstatus\b"?\s*=/i.test(setClause)) offenders.push(rel(file));
    }
  }
  expect(offenders).toEqual([]);
});

test('the claim helper is pointed at gateway_withdrawal only by the service adapter', () => {
  const found = collectTsFiles(SRC_ROOT)
    .filter((file) => /table:\s*['"]gateway_withdrawal['"]/.test(code(file)))
    .map(rel)
    .sort();
  expect(found).toEqual([
    // A read-only report config (finance totals), not a claim.
    'api/reports/finance/queries.ts',
    'modules/packs/service.ts',
  ]);
});

test('the raw-SQL scan sees a status write when there is one', () => {
  const update = /update\s+"?gateway_withdrawal"?\s+set\b((?:(?!\bwhere\b)[\s\S])*)/gi;
  const [[, setClause]] = [
    ...`UPDATE gateway_withdrawal SET status = 'failed' WHERE id = ?`.matchAll(update),
  ];
  expect(setClause).toMatch(/\bstatus\b"?\s*=/i);
});
