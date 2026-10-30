import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { luckyDrawPageFor } from './view';

// GET /store/lucky-draw — the live event's prizes with totals, the top 10
// entrants, the viewer's own tickets and balance, and the result of any prize
// already drawn. A one_winner event carries those on `event` too, and
// `next_event` names what comes next. The shared half is cached in view.ts; no
// seed is in this payload until its result exists.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await luckyDrawPageFor(req, packs, customerId));
}
