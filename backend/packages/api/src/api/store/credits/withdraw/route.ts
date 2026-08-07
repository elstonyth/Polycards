import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { startGlobePayWithdrawal } from '../../../../modules/packs/globepay-withdrawal';

// POST /store/credits/withdraw — start a real GlobePay365 payout (method WD).
// The ledger is debited HERE, before the gateway call; a refused or failed
// payout refunds it (globepay-withdrawal.ts / the withdrawal hook / the
// sweep — all sharing one refund idempotency anchor).
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts. The customer id
// comes ONLY from the verified token. The gateway's own callback is
// POST /hooks/globepay/withdrawal, outside /store/*, authenticated by the RSA
// signature.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  // Register-phase JWTs pass authenticate('customer') with actor_id '' (the
  // documented repo trap — see withdraw/accounts/route.ts and
  // profile/frame/route.ts). Without this guard the empty id flows into the
  // withdrawal gate, whose walletSummary('') sums an empty ledger and reports
  // "You can withdraw up to RM 0.00 right now." — a confusing INVALID_DATA
  // where the truth is a 401, so the client's isAuthError never offers the
  // login prompt.
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const body = (req.body ?? {}) as {
    amount?: unknown;
    bank_code?: unknown;
    account_number?: unknown;
    account_holder_name?: unknown;
  };

  const notifyUrl = process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL;
  const verifyUrl = process.env.GLOBEPAY_PAYOUT_VERIFY_URL;
  if (!notifyUrl || !verifyUrl) {
    // Fail closed: without a reachable NotifyUrl a failed payout could never
    // refund, and without a verify URL their Payout Verification (if active)
    // would reject every payout with nothing in our logs explaining why.
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Withdrawals are not open yet.',
    );
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.ip ||
    req.socket?.remoteAddress ||
    '0.0.0.0';

  const result = await startGlobePayWithdrawal(
    req.scope,
    {
      customerId,
      amount: body.amount,
      bankCode: body.bank_code,
      accountNumber: body.account_number,
      accountHolderName: body.account_holder_name,
      ipAddress,
    },
    notifyUrl,
    verifyUrl,
  );

  res.json(result);
}
