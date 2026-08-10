import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { startGlobePayDeposit } from '../../../../modules/packs/globepay-deposit';
import { payerIpOf } from '../../../utils/payer-ip';

// POST /store/credits/deposit — start a real GlobePay365 top-up. Returns a
// cashier URL; NO credit is issued here. The customer pays on their page, and
// credit lands only when a verified callback reports success
// (POST /hooks/globepay/deposit).
//
// This sits ALONGSIDE /store/credits/topup (the mock gateway) rather than
// replacing it: the mock stays the local/dev path, and the storefront picks
// per environment. Retiring the mock is a storefront change, not a backend one.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts. The customer id
// comes ONLY from the verified token.
//
// Callback/return URLs are explicit env vars rather than derived from a
// STOREFRONT_URL-style var: production defines MERCUR_STOREFRONT_URL, so
// deriving would silently fall back to a localhost default and the gateway
// would call an address that does not exist.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const body = (req.body ?? {}) as {
    amount?: unknown;
    payment_method_code?: unknown;
  };

  const notifyUrl = process.env.GLOBEPAY_NOTIFY_URL;
  const returnUrl = process.env.GLOBEPAY_RETURN_URL;
  if (!notifyUrl || !returnUrl) {
    // Fail closed: without a reachable NotifyUrl the customer could pay and we
    // would never hear about it — money in, no credit.
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Top-ups are temporarily unavailable.',
    );
  }

  // The paying customer's IP, derived from the proxy chain — NOT from the
  // client-settable header. See src/api/utils/payer-ip.ts for why the order
  // matters.
  const ipAddress = payerIpOf(req);

  const method =
    typeof body.payment_method_code === 'string'
      ? body.payment_method_code
      : undefined;

  const result = await startGlobePayDeposit(
    req.scope,
    { customerId, amount: body.amount, ipAddress, paymentMethodCode: method },
    notifyUrl,
    returnUrl,
  );

  res.json(result);
}
