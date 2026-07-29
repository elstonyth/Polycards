import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { startGlobePayDeposit } from '../../../../modules/packs/globepay-deposit';

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

  // THEIR requirement is the paying customer's IP, not ours. req.ip FIRST:
  // Medusa's express-loader sets `trust proxy` 1 unconditionally, so req.ip is
  // derived from the proxy chain and a client cannot set it. The raw
  // X-Forwarded-For first hop is client-controlled — reading it first let a
  // caller choose the IP we report to GlobePay365, so it is only a fallback for
  // a deployment where req.ip is somehow empty.
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress =
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.socket?.remoteAddress ||
    '0.0.0.0';

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
