import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { startGlobePayDeposit } from '../../../../modules/packs/globepay-deposit';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../modules/packs/globepay-reconcile';
import { payerIpOf } from '../../../utils/payer-ip';
import { customerContact } from '../../../utils/customer-contact';
import {
  GATEWAYS,
  gatewayUrls,
  resolveActiveGateway,
} from '../../../../modules/packs/gateway';

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

  // Which gateway is active is an admin setting; refresh the cache (TTL'd)
  // before reading anything derived from it.
  const gateway = await resolveActiveGateway(req.scope);
  const { notifyUrl, returnUrl } = gatewayUrls(gateway);
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

  // Some gateways (TGPay) require the payer's contact on create-payment;
  // GlobePay does not, and its route tests run with an empty scope, so only
  // look it up when the active gateway asks for it.
  const customer = GATEWAYS[gateway].needsCustomerContact
    ? await customerContact(req.scope, customerId)
    : undefined;
  const result = await startGlobePayDeposit(
    req.scope,
    {
      customerId,
      amount: body.amount,
      ipAddress,
      paymentMethodCode: method,
      customer,
    },
    notifyUrl,
    returnUrl,
  );

  res.json(result);
}

/**
 * How many in-flight deposits to report. A customer with more than a handful
 * open at once is re-clicking, not paying five ways — and the storefront only
 * needs enough to say "we can see your payment", never a history.
 */
const PENDING_LIMIT = 5;

// GET /store/credits/deposit — the caller's OWN in-flight top-ups.
//
// Why this exists: the ledger is the only thing /transactions could read, and a
// deposit writes nothing to the ledger until it settles. So a customer who paid
// and came back landed on a page with no trace of their money at all and
// concluded the payment had failed — worst exactly when settlement is slow,
// which is the case this was built for.
//
// Deliberately NOT a status oracle: it reports what WE recorded, never a fresh
// gateway requery. Requerying per page view would put an unauthenticated-ish
// read on the gateway's rate budget and duplicate the sweep's job; the sweep
// (globepay-reconcile, every minute) and the callback remain the only things
// that resolve a deposit.
//
// Bounded by the same GLOBEPAY_STALE_AFTER_MS the sweep and the admin page use:
// past that window the customer has almost certainly abandoned the cashier, and
// showing "confirming your payment" forever would be a lie with a countdown.
// The constant is imported, not redeclared, so the three surfaces cannot drift.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts (its own GET entry,
// sharing the store READ budget — the POST entry above pins method:'POST').
// The customer id comes ONLY from the verified token: filtering on a body or
// query value would let any logged-in customer read another's deposits.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const deposits = await packs.listGlobePayDeposits(
    {
      customer_id: customerId,
      status: 'pending',
      created_at: { $gte: new Date(Date.now() - GLOBEPAY_STALE_AFTER_MS) },
    },
    { take: PENDING_LIMIT, order: { created_at: 'DESC' } },
  );

  // Hand-picked fields, not the row: it also carries the gateway id and our
  // internal status vocabulary, and the amount reported is the one we REQUESTED
  // (the settled figure can differ, and until it settles we do not know it).
  res.json({
    deposits: deposits.map((deposit) => ({
      merchant_transaction_id: deposit.merchant_transaction_id,
      amount: deposit.amount_requested,
      payment_method_code: deposit.payment_method_code,
      created_at: deposit.created_at,
    })),
  });
}
