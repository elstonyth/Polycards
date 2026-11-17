/**
 * Source-scan seal: every write to a gateway_withdrawal row goes through the
 * Withdrawal lifecycle (modules/packs/withdrawal-lifecycle.ts).
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
