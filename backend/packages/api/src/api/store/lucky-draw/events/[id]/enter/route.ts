import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// POST /store/lucky-draw/events/:id/enter { tickets } — spend tickets on a
// one_winner event. The same answers as the prize route: a refusal is a 200 with
// { entered: false, reason }, a bad amount a 400. Only `tickets` is read from the
// body: the start and end gates run on the server clock.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const body = (req.body ?? {}) as { tickets?: unknown };
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(
    await packs.enterLuckyDrawEvent({
      customerId,
      eventId: req.params.id,
      tickets: body.tickets,
    }),
  );
}
