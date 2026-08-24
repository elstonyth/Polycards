import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// POST /admin/referrals/settlements/:id/pay — "Pay now": runs the Wednesday
// step early for one approved run. Same idempotent path the cron takes;
// deleted-account voiding and the pay_settlement audit live inside
// payWeeklySettlement so the two callers can't drift.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(
    await packs.payWeeklySettlement({
      settlementId: req.params.id,
      adminId: req.auth_context.actor_id,
    }),
  );
}
