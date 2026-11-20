import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  GATEWAYS,
  LEDGER_CURRENCY,
} from '../../../../../modules/packs/gateway';
import {
  PAYER_BANK_REQUIRED_MESSAGE,
  PAYER_NAME_INCOMPLETE_MESSAGE,
  payerNameLooksFull,
  regionalDepositGateway,
} from '../../../../../modules/packs/gateway-deposit';
import { payerNameOnFile, payerOnFile } from '../../../../utils/payer-name';

// GET /store/credits/deposit/payer?currency=SGD — the name the S$ top-up
// sheet shows for the paying bank account, which the rail matches every SGD
// transfer against. `saved_name` comes from the same rule the deposit itself
// uses (api/utils/payer-name.ts): the holder of a saved account at a bank the
// rail pays. Both it and `real_name` are the caller's own data.
//
// A3Pay (`fixed_name` false): the sheet shows the name with "Change" (the
// customer may pay from another account), or, with none saved, asks,
// pre-filled with `real_name`.
//
// GMpay (`fixed_name` true): the name is the saved account's holder and
// nothing else (the deposit route ignores a typed one), so the sheet shows it
// without "Change". `blocked_reason` is the refusal the deposit would give
// (no saved account, or a name GMpay can never match), so the sheet can say
// so before the customer presses Pay.
//
// AUTH + RATE LIMIT: src/api/middlewares.ts. The customer id comes ONLY from
// the verified token.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.query?.currency;
  const currency = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (currency === LEDGER_CURRENCY) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `${LEDGER_CURRENCY} top-ups need no payer name.`,
    );
  }
  const gateway = currency ? regionalDepositGateway(currency) : null;
  if (!gateway) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `${currency || 'These'} top-ups are not available right now.`,
    );
  }
  const customerId = req.auth_context.actor_id;
  res.setHeader('Cache-Control', 'no-store');
  if (GATEWAYS[gateway].needsPayerBank) {
    const { name, account, realName } = await payerOnFile(
      req.scope,
      customerId,
      gateway,
      undefined,
    );
    const blocked = !account
      ? PAYER_BANK_REQUIRED_MESSAGE
      : !name || !payerNameLooksFull(name)
        ? PAYER_NAME_INCOMPLETE_MESSAGE
        : null;
    res.json({
      currency,
      saved_name: name ?? null,
      real_name: realName,
      fixed_name: true,
      blocked_reason: blocked,
    });
    return;
  }
  const { onFile, realName } = await payerNameOnFile(
    req.scope,
    customerId,
    gateway,
  );
  res.json({
    currency,
    saved_name: onFile ?? null,
    real_name: realName,
    fixed_name: false,
    blocked_reason: null,
  });
}
