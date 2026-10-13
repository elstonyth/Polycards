import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { regionalDepositGateway } from '../../../../../modules/packs/gateway-deposit';
import { payerNameOnFile } from '../../../../utils/payer-name';

// GET /store/credits/deposit/payer?currency=SGD — does the top-up sheet need
// to ask for the name on the paying bank account? A3Pay matches every SGD
// transfer against that name. The answer comes from the same rule the deposit
// itself uses (api/utils/payer-name.ts): a saved account at a bank the rail
// pays settles it; otherwise the sheet asks, pre-filled with the real name.
// The name on file itself is never returned, only whether there is one.
//
// AUTH + RATE LIMIT: src/api/middlewares.ts. The customer id comes ONLY from
// the verified token.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.query?.currency;
  const currency = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
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
  res.json({ currency, name_on_file: Boolean(onFile), real_name: realName });
}
