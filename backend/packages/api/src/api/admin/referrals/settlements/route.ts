import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

const STATUSES = ['draft', 'approved', 'paid', 'void'] as const;

// GET /admin/referrals/settlements[?status=] — settlement runs, newest week
// first (the Referrals page run list).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const status = STATUSES.find((s) => s === req.query.status);
  const runs = await packs.listWeeklySettlements(status ? { status } : {}, {
    order: { week_start: 'DESC' },
    take: 100,
  });
  res.json({
    settlements: runs.map((r) => ({
      id: r.id,
      week_start: new Date(r.week_start).toISOString().slice(0, 10),
      status: r.status,
      approved_by: r.approved_by,
      approved_at: r.approved_at,
      paid_at: r.paid_at,
      total_commission_cents: r.total_commission_cents,
    })),
  });
}
