import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// GET /admin/globepay/withdrawals/:id/account — the full destination bank
// account for ONE withdrawal.
//
// WHY this exists: the list route (../../route.ts) masks account_number, and
// masking without a reveal path is worse than no masking — it moves the
// operator to the database console, where nothing is rate-limited and nothing
// is audited. Chasing a disputed payout genuinely needs the full number; it
// needs it one row at a time.
//
// The three properties that make the masking survivable, all deliberate:
//   1. ONE row per request. No bulk variant, no id list. Walking the table
//      costs one authenticated, logged, rate-limited request per row.
//   2. Rate-limited on the shared admin-action budget (src/api/middlewares.ts)
//      — the only GET on that limiter, registered there precisely because a
//      compromised admin token must not be able to re-derive the bulk view.
//   3. Every reveal is logged with the row id and the admin actor id, and
//      NEVER the number itself — a log line about bank details must not become
//      the bank-details leak it exists to make auditable (the same reasoning
//      that removed the deposit hook's AdditionalInformationData log).
//
// Admin-only by the framework's /admin auth guard, same as every sibling here.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [row] = await packs.listGlobePayWithdrawals(
    { id: req.params.id },
    { take: 1 },
  );
  // Checked BEFORE the audit line: logging a reveal for a row that does not
  // exist would record an access that never happened.
  if (!row) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Withdrawal '${req.params.id}' not found.`,
    );
  }

  req.scope
    .resolve('logger')
    .info(
      `[globepay] admin ${req.auth_context.actor_id} revealed the destination account of withdrawal ${row.id}`,
    );

  // Same CWE-524 rule as the list route, for the one response that still
  // carries a full bank account. Belt-and-braces with the blanket '/admin/*'
  // no-store matcher in middlewares.ts.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ id: row.id, account_number: row.account_number });
}
