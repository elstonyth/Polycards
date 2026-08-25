import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// GET /admin/referrals/settlements/:id — one run with all its lines (the
// review drawer the approve decision is made from).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [run] = await packs.listWeeklySettlements(
    { id: req.params.id },
    { take: 1 },
  );
  if (!run) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Settlement ${req.params.id} not found.`,
    );
  }
  const lines = await packs.listWeeklySettlementLines(
    { settlement_id: run.id },
    { order: { amount_cents: 'DESC' }, take: 100_000 },
  );
  res.json({
    settlement: {
      id: run.id,
      week_start: new Date(run.week_start).toISOString().slice(0, 10),
      status: run.status,
      approved_by: run.approved_by,
      approved_at: run.approved_at,
      paid_at: run.paid_at,
      total_commission_cents: run.total_commission_cents,
    },
    lines: lines.map((l) => ({
      id: l.id,
      customer_id: l.customer_id,
      basis_cents: l.basis_cents,
      rate_bp: l.rate_bp,
      amount_cents: l.amount_cents,
      status: l.status,
      void_reason: l.void_reason,
      paid_transaction_id: l.paid_transaction_id,
    })),
  });
}
