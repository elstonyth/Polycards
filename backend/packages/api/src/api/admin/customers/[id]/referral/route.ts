import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import { reqReason } from '../../../rewards-settings/validate';
import { resolveGroupPolicyForCustomer } from '../../../../../modules/packs/group-policy';
import {
  MAX_SETTLEMENT_LINE_MYR,
  REFERRAL_AUTO_APPROVE_MAX_LINE_MYR,
  referralWeekFor,
} from '../../../../../modules/packs/referral';

// GET /admin/customers/:id/referral — the Customer-360 referral card: who
// referred them, their direct downline with each member's spend, this week's
// live commission (the same numbers the player's own /referral page shows),
// their partner rate, and their settlement lines, newest first.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  // ONE instant for the header week and the per-member week spend, so a read
  // across the Tuesday 00:00 MYT cutover cannot mix two weeks.
  const now = new Date();

  const [[referredBy], downline, [state], lines, groupPolicy, live] =
    await Promise.all([
      packs.listReferralAttributions({ customer_id: customerId }, { take: 1 }),
      // shortcut: the card lists at most 1000 members; page it if a partner
      // ever outgrows that.
      packs.listReferralAttributions(
        { referrer_id: customerId },
        { order: { created_at: 'DESC' }, take: 1000 },
      ),
      packs.listCustomerAccountStates({ customer_id: customerId }, { take: 1 }),
      packs.listWeeklySettlementLines(
        { customer_id: customerId },
        { order: { created_at: 'DESC' }, take: 50 },
      ),
      resolveGroupPolicyForCustomer(req.scope, customerId),
      packs.referralLiveWeek({ customerId, now }),
    ]);

  // The referrer's name for the card; a deleted customer has no row.
  const [referrer] = referredBy
    ? await customers.listCustomers(
        { id: referredBy.referrer_id },
        { take: 1, select: ['email', 'first_name', 'last_name'] },
      )
    : [];
  const memberIds = downline.map((d) => d.customer_id);
  const settlementIds = [...new Set(lines.map((l) => l.settlement_id))];
  // ONE batched lookup each for spend, names and line weeks, never per row.
  const spend = await packs.referralDownlineSpend({
    customerIds: memberIds,
    now,
  });
  const people = memberIds.length
    ? await customers.listCustomers(
        { id: memberIds },
        {
          take: memberIds.length,
          select: ['id', 'email', 'first_name', 'last_name'],
        },
      )
    : [];
  const runs = settlementIds.length
    ? await packs.listWeeklySettlements(
        { id: settlementIds },
        { select: ['id', 'week_start'], take: settlementIds.length },
      )
    : [];
  const personById = new Map(people.map((c) => [c.id, c]));
  // week_start is the Tuesday-00:00-MYT instant (Monday 16:00 UTC), so its
  // UTC date is a day early — name the week by its MYT date.
  const weekById = new Map(
    runs.map((r) => [
      r.id,
      referralWeekFor(new Date(r.week_start)).weekStartIso,
    ]),
  );

  // Partner groups (spec 2026-09-09): when the player's group is a partner
  // group its rate is what pays them, and the card locks the manual control.
  const partnerGroup =
    groupPolicy && groupPolicy.policy.partner_rate_bp !== null
      ? {
          id: groupPolicy.group.id,
          name: groupPolicy.group.name,
          rate_bp: groupPolicy.policy.partner_rate_bp,
        }
      : null;

  res.json({
    referred_by: referredBy?.referrer_id ?? null,
    referred_by_label: referrer
      ? [referrer.first_name, referrer.last_name].filter(Boolean).join(' ') ||
        referrer.email
      : null,
    partner_referral_bp: state?.partner_referral_bp ?? null,
    partner_group: partnerGroup,
    // Uncapped, unlike the downline list below.
    downline_count: live.downline_count,
    week: live.week,
    // What can stop the week's line paying on Wednesday: over the auto-approve
    // limit it waits for an admin; over the ceiling the close voids it.
    payout_limits: {
      auto_approve_max_cents: REFERRAL_AUTO_APPROVE_MAX_LINE_MYR * 100,
      line_ceiling_cents: MAX_SETTLEMENT_LINE_MYR * 100,
    },
    // A deleted customer has no row — the id alone still identifies them.
    downline: downline.map((d) => {
      const c = personById.get(d.customer_id);
      const s = spend.get(d.customer_id);
      return {
        customer_id: d.customer_id,
        since: d.created_at,
        name: c
          ? [c.first_name, c.last_name].filter(Boolean).join(' ') || null
          : null,
        email: c?.email ?? null,
        week_spend_cents: s?.week_cents ?? 0,
        lifetime_spend_cents: s?.lifetime_cents ?? 0,
      };
    }),
    lines: lines.map((l) => ({
      id: l.id,
      settlement_id: l.settlement_id,
      week_start: weekById.get(l.settlement_id) ?? null,
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
