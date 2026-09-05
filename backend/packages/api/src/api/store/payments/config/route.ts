import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  GATEWAYS,
  resolveActiveGateway,
} from '../../../../modules/packs/gateway';
import { globepayEnabled } from '../../../../modules/packs/globepay-deposit';
import { globepayWithdrawalsEnabled } from '../../../../modules/packs/globepay-withdrawal';

// GET /store/payments/config — what the storefront needs to render the top-up
// sheet and the withdrawal form for the ACTIVE gateway: its money bands and
// whether each channel is open. Public (publishable key only): nothing here
// is secret, and the sheet must know the floor before the customer types.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const gateway = await resolveActiveGateway(req.scope);
  const { limits } = GATEWAYS[gateway];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    gateway,
    deposits_enabled: globepayEnabled(),
    withdrawals_enabled: globepayWithdrawalsEnabled(),
    deposit: { min_rm: limits.depositMin, max_rm: limits.depositMax },
    withdrawal: { min_rm: limits.withdrawalMin, max_rm: limits.withdrawalMax },
  });
}
