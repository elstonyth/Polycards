import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import { reqReason } from '../../../rewards-settings/validate';

// GET /admin/customers/:id/referral — the Customer-360 referral card: who
// referred them, their direct downline, their partner rate, and their
// settlement lines (both kinds), newest first.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const [[referredBy], downline, [state], lines] = await Promise.all([
    packs.listReferralAttributions({ customer_id: customerId }, { take: 1 }),
    packs.listReferralAttributions(
      { referrer_id: customerId },
      { order: { created_at: 'DESC' }, take: 1000 },
    ),
    packs.listCustomerAccountStates({ customer_id: customerId }, { take: 1 }),
    packs.listWeeklySettlementLines(
      { customer_id: customerId },
      { order: { created_at: 'DESC' }, take: 50 },
    ),
  ]);

  res.json({
    referred_by: referredBy?.referrer_id ?? null,
    partner_referral_bp: state?.partner_referral_bp ?? null,
    downline: downline.map((d) => ({
      customer_id: d.customer_id,
      since: d.created_at,
    })),
    lines: lines.map((l) => ({
      id: l.id,
      settlement_id: l.settlement_id,
      basis_cents: l.basis_cents,
      rate_bp: l.rate_bp,
      amount_cents: l.amount_cents,
      status: l.status,
    })),
  });
}

// POST /admin/customers/:id/referral { referrer_id, reason } — admin set/fix
// of attribution (spec: "Admin can set/fix one manually"). referrer_id null
// clears it. Unlike the customer bind, this may OVERRIDE an existing row;
// audited in the service.
export async function POST(
  req: AuthenticatedMedusaRequest<{ referrer_id?: unknown; reason?: unknown }>,
  res: MedusaResponse,
): Promise<void> {
  const referrerId = req.body?.referrer_id ?? null;
  if (referrerId !== null && typeof referrerId !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'referrer_id must be a customer id string or null.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  await packs.adminSetReferral({
    customerId: req.params.id,
    referrerId,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
    referrerExists: async (id) => {
      const rows = await customers.listCustomers({ id }, { take: 1 });
      return rows.length > 0;
    },
  });
  res.json({ ok: true });
}
