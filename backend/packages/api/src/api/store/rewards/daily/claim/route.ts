import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// POST /store/rewards/daily/claim — claim today's check-in reward. Idempotent
// per MYT day (advisory lock + unique claim row + idempotent ledger write);
// covered by the `/store/rewards/*` POST middleware entry (bearer auth +
// delivery write-tier rate limit). actor_id comes from the verified token.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.claimDaily(customerId);

  if (result.status === 'disabled') {
    res.status(409).json({
      code: 'disabled',
      message: 'Daily rewards are paused right now.',
    });
    return;
  }
  if (result.status === 'already_claimed') {
    res.status(409).json({
      code: 'already_claimed',
      message: 'Today’s reward is already claimed — come back tomorrow.',
    });
    return;
  }
  res.json(result);
}
