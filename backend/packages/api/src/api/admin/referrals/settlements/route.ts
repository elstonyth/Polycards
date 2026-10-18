import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import {
  REFERRAL_AUTO_APPROVE_MAX_LINE_MYR,
  referralWeekFor,
} from '../../../../modules/packs/referral';
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
  // Drafts the auto-approval will not touch: a pending line over its limit.
  const draftIds = runs.filter((r) => r.status === 'draft').map((r) => r.id);
  const heldIds = new Set(
    draftIds.length
      ? (
          await packs.listWeeklySettlementLines(
            {
              settlement_id: draftIds,
              status: 'pending',
              amount_cents: { $gt: REFERRAL_AUTO_APPROVE_MAX_LINE_MYR * 100 },
            },
            { select: ['settlement_id'], take: 1000 },
          )
        ).map((l) => l.settlement_id)
      : [],
  );
  res.json({
    settlements: runs.map((r) => ({
      id: r.id,
      // Stored as Tuesday 00:00 MYT (Monday 16:00 UTC): name it by the MYT
      // date, not the UTC one a day early.
      week_start: referralWeekFor(new Date(r.week_start)).weekStartIso,
      status: r.status,
      approved_by: r.approved_by,
      approved_at: r.approved_at,
      paid_at: r.paid_at,
      total_commission_cents: r.total_commission_cents,
      held_for_review: heldIds.has(r.id),
    })),
  });
}
