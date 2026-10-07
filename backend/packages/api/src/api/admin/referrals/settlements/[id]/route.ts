import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// GET /admin/referrals/settlements/:id — one run with all its lines (the
// review drawer the approve decision is made from). Each line names the
// referrer it pays (a bare cus_ id told the operator nothing) and lists the
// downline whose spend that week makes up its basis.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
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
  const [lines, downline] = await Promise.all([
    packs.listWeeklySettlementLines(
      { settlement_id: run.id },
      { order: { amount_cents: 'DESC' }, take: 100_000 },
    ),
    packs.referralDownlineForWeek({ weekStart: new Date(run.week_start) }),
  ]);

  // ONE batched customer lookup for referrers and their downline, never per
  // row (ledger route precedent).
  const ids = new Set<string>();
  for (const l of lines) {
    ids.add(l.customer_id);
    for (const m of downline.get(l.customer_id) ?? []) ids.add(m.customer_id);
  }
  const rows = ids.size
    ? await customers.listCustomers(
        { id: [...ids] },
        {
          take: ids.size,
          select: ['id', 'email', 'first_name', 'last_name', 'phone'],
        },
      )
    : [];
  const byId = new Map(rows.map((c) => [c.id, c]));
  // A deleted customer has no row — the id alone still identifies them.
  const who = (id: string) => {
    const c = byId.get(id);
    return {
      id,
      name: c
        ? [c.first_name, c.last_name].filter(Boolean).join(' ') || null
        : null,
      email: c?.email ?? null,
      phone: c?.phone ?? null,
    };
  };

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
      customer: who(l.customer_id),
      basis_cents: l.basis_cents,
      rate_bp: l.rate_bp,
      amount_cents: l.amount_cents,
      status: l.status,
      void_reason: l.void_reason,
      paid_transaction_id: l.paid_transaction_id,
      downline: (downline.get(l.customer_id) ?? []).map((m) => ({
        customer: who(m.customer_id),
        spend_cents: m.spend_cents,
      })),
    })),
  });
}
