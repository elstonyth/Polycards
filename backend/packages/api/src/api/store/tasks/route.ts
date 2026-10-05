import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /store/tasks — the /task Tasks tab payload: every active task with the
// logged-in customer's live progress and claim state, plus today's check-in
// state (whether the button is still pressable).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const hub = await packs.taskHubFor({ customerId });
  // The hub's own day, so the button state and the day's counts can never
  // straddle MYT midnight between two clock reads.
  const [todays] = await packs.listDailyCheckins(
    { customer_id: customerId, checkin_date: hub.day_key },
    { take: 1 },
  );
  res.json({ ...hub, checked_in_today: Boolean(todays) });
}
