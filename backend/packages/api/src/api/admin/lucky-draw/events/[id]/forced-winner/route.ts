import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/lucky-draw/events/:id/forced-winner — guaranteed win
// (2026-11-24): pick the customer the draw job pays when this one_winner event
// ends, whatever the seed says. `customer_id: null` clears the pick. The
// event, entrant and draw-state rules are the service's.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  if (
    raw.customer_id !== null &&
    (typeof raw.customer_id !== 'string' || raw.customer_id === '')
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'customer_id must be text or null.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const forcedWinner = await packs.forceLuckyDrawWinner({
    id: req.params.id,
    customerId: (raw.customer_id as string | null) ?? null,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json(forcedWinner);
}
