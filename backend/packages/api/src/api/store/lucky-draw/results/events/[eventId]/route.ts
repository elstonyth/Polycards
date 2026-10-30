import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { eventDetailFor } from '../../../view';

// GET /store/lucky-draw/results/events/:eventId — one drawn one_winner event: the
// revealed seed, every prize, the frozen entry list in draw order and the winning
// ticket index, so anyone can re-run the pick. 404 until it is drawn.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!req.auth_context?.actor_id) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const detail = await eventDetailFor(req, packs, req.params.eventId);
  if (!detail) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No result yet');
  }
  res.json(detail);
}
