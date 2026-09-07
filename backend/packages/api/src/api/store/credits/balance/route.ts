import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  resolvePacks,
  type CustomerWallet,
} from '../../../../modules/packs/facets';

// GET /store/credits/balance — the bare number for hot callers (header chip,
// vault page). The full wallet/ledger view stays on GET /store/credits.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = resolvePacks<CustomerWallet>(req.scope);
  res.json({ balance: await packs.creditBalance(req.auth_context.actor_id) });
}
