import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { coinFlipQuoteBody } from '../validate';

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const selection = coinFlipQuoteBody(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json({ round: await packs.quoteCoinFlip({ customerId: req.auth_context.actor_id, ...selection }) });
}
