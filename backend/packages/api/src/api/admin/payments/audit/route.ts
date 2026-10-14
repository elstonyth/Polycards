import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayReports,
} from '../../../../modules/packs/facets';
import {
  gatewaysFor,
  LEDGER_CURRENCY,
  RETIRED_GATEWAYS,
  rowGateway,
} from '../../../../modules/packs/gateway';
import { toOptionalMoney } from '../../../../modules/packs/money';
import {
  paymentCurrencyParam,
  railGateway,
} from '../../../utils/payment-currency';

// GET /admin/payments/audit — the gateway-as-source-of-truth view (plan 130):
// OUR all-time settled totals, and every row the audit sweep found the
// gateway disagreeing with. Read-only. The gateway's live wallet is
// /admin/payments/balance, shown once at the top of the same page.
//
// ?currency= scopes it to one rail (default RM): its gateway's totals, the
// history of the other gateways in that currency, and its rows' findings.

const FINDINGS_LIMIT = 100;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const packs = resolvePacks<GatewayReports>(req.scope);
  const currency = paymentCurrencyParam(req.query.currency) ?? LEDGER_CURRENCY;
  const active = await railGateway(req.scope, currency);

  // Totals for the rail's gateway (for RM the ACTIVE one); every other
  // gateway in this currency that ever settled a row is listed separately,
  // so a switch never makes the old gateway's history vanish from the one
  // page that reconciles it.
  const totals = await packs.gatewayAuditTotals(active);
  // The findings list below covers every gateway in this currency, so the
  // count does too, except a retired gateway's rows: they can never be
  // checked again ("not configured here"), so they are counted apart and
  // never hold up the "payments differ" badge.
  let findingsTotal = totals.findings;
  let retiredTotal = 0;
  const history: ({ gateway: string } & ReturnType<typeof moneyTotals>)[] = [];
  // Retired gateways (globepay) were all RM.
  const others = [
    ...gatewaysFor(currency),
    ...(currency === LEDGER_CURRENCY ? RETIRED_GATEWAYS : []),
  ];
  for (const id of others) {
    if (id === active) continue;
    const t = await packs.gatewayAuditTotals(id);
    if (RETIRED_GATEWAYS.includes(id)) retiredTotal += t.findings;
    else findingsTotal += t.findings;
    if (t.deposits.count + t.withdrawals.count > 0) {
      history.push({ gateway: id, ...moneyTotals(t) });
    }
  }

  const [deposits, withdrawals] = await Promise.all([
    packs.listGatewayDeposits(
      { audit_note: { $ne: null }, currency },
      { take: FINDINGS_LIMIT, order: { audited_at: 'DESC' } },
    ),
    packs.listGatewayWithdrawals(
      { audit_note: { $ne: null }, currency },
      { take: FINDINGS_LIMIT, order: { audited_at: 'DESC' } },
    ),
  ]);

  const findings = [
    ...deposits.map((d) => ({
      kind: 'deposit' as const,
      gateway: d.gateway ?? rowGateway(d),
      id: d.id,
      merchant_transaction_id: d.merchant_transaction_id,
      gateway_transaction_id: d.gateway_transaction_id,
      customer_id: d.customer_id,
      status: d.status,
      amount:
        toOptionalMoney(d.amount_settled) ??
        toOptionalMoney(d.amount_requested),
      note: d.audit_note,
      audited_at: d.audited_at,
    })),
    ...withdrawals.map((w) => ({
      kind: 'withdrawal' as const,
      gateway: w.gateway ?? rowGateway(w),
      id: w.id,
      merchant_transaction_id: w.merchant_transaction_id,
      gateway_transaction_id: w.gateway_transaction_id,
      customer_id: w.customer_id,
      status: w.status,
      amount: toOptionalMoney(w.amount),
      note: w.audit_note,
      audited_at: w.audited_at,
    })),
  ].sort((a, b) =>
    String(b.audited_at ?? '').localeCompare(String(a.audited_at ?? '')),
  );

  res.json({
    currency,
    gateway: active,
    last_audited_at: totals.lastAuditedAt,
    findings_total: findingsTotal,
    retired_total: retiredTotal,
    totals: moneyTotals(totals),
    history,
    findings: findings.slice(0, FINDINGS_LIMIT),
  });
}

type SideTotals = {
  count: number;
  grossCents: number;
  netCents: number;
  missingNet: number;
  missingGross: number;
};
function moneyTotals(t: { deposits: SideTotals; withdrawals: SideTotals }) {
  const side = (s: SideTotals) => ({
    count: s.count,
    gross: s.grossCents / 100,
    net: s.netCents / 100,
    missing_net: s.missingNet,
    // Same NULL rule the settlement report already publishes: a settled
    // deposit with no amount_settled (settled by hand) contributes 0 to the
    // sum, so `gross` is a FLOOR whenever this is non-zero.
    missing_gross: s.missingGross,
  });
  return { deposits: side(t.deposits), withdrawals: side(t.withdrawals) };
}
