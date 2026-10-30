import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// POST /store/lucky-draw/prizes/:id/enter { tickets } — spend tickets on a
// prize. A refusal (no top-up, not enough tickets, closed...) is a 200 with
// { entered: false, reason }: Medusa's error handler rewrites any CONFLICT
// message, so a 409 would show the wrong words. A bad amount is a 400, thrown
// by the service. Only `tickets` is read from the body: the start and draw-time
// gates run on the server clock, never on anything the client sends.
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
    await packs.enterLuckyDraw({
      customerId,
      prizeId: req.params.id,
      tickets: body.tickets,
    }),
  );
}
