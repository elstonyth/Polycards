import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { startGlobePayWithdrawal } from '../../../../modules/packs/globepay-withdrawal';
import { payerIpOf } from '../../../utils/payer-ip';

// POST /store/credits/withdraw — start a real GlobePay365 payout (method WD).
// The ledger is debited HERE, before the gateway call; a refused or failed
// payout refunds it (globepay-withdrawal.ts / the withdrawal hook / the
// sweep — all sharing one refund idempotency anchor).
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts. The customer id
// comes ONLY from the verified token. The gateway's own callback is
// POST /hooks/globepay/withdrawal, outside /store/*, authenticated by the RSA
// signature.
//
// The body names an `account_id` and NOTHING about the bank. Bank code, account
// number and holder name are resolved from the caller's OWN saved accounts,
// inside the locked transaction that debits — so a stolen token cannot pay out
// to an account its owner never registered and cooled off. Do not re-add bank
// fields here.
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
    account_id?: unknown;
  };

  // Money-out parity with POST /store/credits/topup. Optional: existing clients
  // that send no header keep working exactly as before, they simply get no
  // replay protection. Bounded at the same 200 characters as the top-up route.
  const headerKey = req.headers['idempotency-key'];
  const rawKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  const trimmedKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (trimmedKey.length > 200) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Idempotency-Key must be at most 200 characters.',
    );
  }

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

  // The paying customer's IP, derived from the proxy chain — NOT from the
  // client-settable header. See src/api/utils/payer-ip.ts for why the order
  // matters.
  const ipAddress = payerIpOf(req);

  const result = await startGlobePayWithdrawal(
    req.scope,
    {
      customerId,
      amount: body.amount,
      accountId: body.account_id,
      ipAddress,
      idempotencyKey: trimmedKey !== '' ? trimmedKey : undefined,
    },
    notifyUrl,
    verifyUrl,
  );

  res.json(result);
}
