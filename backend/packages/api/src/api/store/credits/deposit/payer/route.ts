import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { LEDGER_CURRENCY } from '../../../../../modules/packs/gateway';
import { regionalDepositGateway } from '../../../../../modules/packs/gateway-deposit';
import { payerNameOnFile } from '../../../../utils/payer-name';

// GET /store/credits/deposit/payer?currency=SGD — the name the S$ top-up
// sheet shows for the paying bank account, which A3Pay matches every SGD
// transfer against. `saved_name` comes from the same rule the deposit itself
// uses (api/utils/payer-name.ts): the holder of a saved account at a bank the
// rail pays. The sheet shows it with "Change" (the customer may pay from
// another account), or, with none saved, asks, pre-filled with `real_name`.
// Both are the caller's own data.
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
  const { onFile, realName } = await payerNameOnFile(
    req.scope,
    req.auth_context.actor_id,
    gateway,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({ currency, saved_name: onFile ?? null, real_name: realName });
}
