// Dev fixture: seed one HELD GlobePay withdrawal so the admin /withdrawals
// page has an approvable row to demo locally (plan 094 UI). Local use only —
// it fabricates a payout row with no matching ledger debit, so approving it
// against a real gateway would pay out money nobody was charged for.
//
//   corepack yarn medusa exec ./src/scripts/seed-held-withdrawal.ts
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

export default async function seedHeldWithdrawal({
  container,
}: {
  container: { resolve: <T>(k: string) => T };
}): Promise<void> {
  // The fabricated row has no matching ledger debit — approving it against a
  // real gateway pays out money nobody was charged for. Refuse anywhere prod.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[seed-held-withdrawal] refusing to run in production');
  }
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const stamp = Date.now();
  const rows = await packs.createGlobePayWithdrawals([
    {
      merchant_transaction_id: `PC-helddemo${stamp}`,
      customer_id: 'cus_01KY4H64BASH0EYSN3HX0ZHT6D',
      amount: 1500,
      bank_code: 'MYMB2U',
      account_number: '157023456789',
      account_holder_name: 'AHMAD BIN ALI',
      status: 'held' as const,
    },
  ]);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    throw new Error(
      '[seed-held-withdrawal] createGlobePayWithdrawals returned no row',
    );
  }
  console.log(`[seed-held-withdrawal] created ${row.id} status=${row.status}`);
}
