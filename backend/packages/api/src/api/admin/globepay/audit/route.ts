import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  checkBalance,
  gatewayConfigFromEnv,
  paymentGateway,
  resolveActiveGateway,
} from '../../../../modules/packs/gateway';
import { globepayEnabled } from '../../../../modules/packs/globepay-deposit';
import { toOptionalMoney } from '../../../../modules/packs/money';

// GET /admin/globepay/audit — the gateway-as-source-of-truth view (plan 130):
// the gateway's live wallet balances beside OUR all-time settled totals, and
// every row the audit sweep found the gateway disagreeing with. Read-only.

const FINDINGS_LIMIT = 100;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const active = await resolveActiveGateway(req.scope);

  // Totals for the ACTIVE gateway only, so they sit beside that gateway's
  // wallet; after a switch the old gateway's history is not mixed in.
  const totals = await packs.gatewayAuditTotals(active);

  // Live wallet read is best-effort: a gateway hiccup must not blank the
  // findings list, which is the part that can name a real money problem.
  let wallet: {
    current: number;
    available: number;
    currency_code: string;
  } | null = null;
  let walletError: string | null = null;
  if (globepayEnabled()) {
    try {
      const b = await checkBalance(gatewayConfigFromEnv());
      wallet = {
        current: b.currentBalance,
        available: b.availableBalance,
        currency_code: b.currencyCode,
      };
      if (b.notes?.length) walletError = b.notes.join('; ');
    } catch (error) {
      walletError = error instanceof Error ? error.message : String(error);
    }
  }

  const [deposits, withdrawals] = await Promise.all([
    packs.listGlobePayDeposits(
      { audit_note: { $ne: null } },
      { take: FINDINGS_LIMIT, order: { audited_at: 'DESC' } },
    ),
    packs.listGlobePayWithdrawals(
      { audit_note: { $ne: null } },
      { take: FINDINGS_LIMIT, order: { audited_at: 'DESC' } },
    ),
  ]);

  const findings = [
    ...deposits.map((d) => ({
      kind: 'deposit' as const,
      id: d.id,
      merchant_transaction_id: d.merchant_transaction_id,
      gateway_transaction_id: d.gateway_transaction_id,
      customer_id: d.customer_id,
      status: d.status,
      amount: toOptionalMoney(d.amount_settled) ?? toOptionalMoney(d.amount_requested),
      note: d.audit_note,
      audited_at: d.audited_at,
    })),
    ...withdrawals.map((w) => ({
      kind: 'withdrawal' as const,
      id: w.id,
      merchant_transaction_id: w.merchant_transaction_id,
      gateway_transaction_id: w.gateway_transaction_id,
      customer_id: w.customer_id,
      status: w.status,
      amount: toOptionalMoney(w.amount),
      note: w.audit_note,
      audited_at: w.audited_at,
    })),
  ].sort((a, b) => String(b.audited_at ?? '').localeCompare(String(a.audited_at ?? '')));

  res.json({
    gateway: paymentGateway(),
    enabled: globepayEnabled(),
    wallet,
    wallet_error: walletError,
    last_audited_at: totals.lastAuditedAt,
    findings_total: totals.findings,
    totals: {
      deposits: {
        count: totals.deposits.count,
        gross: totals.deposits.grossCents / 100,
        net: totals.deposits.netCents / 100,
        missing_net: totals.deposits.missingNet,
      },
      withdrawals: {
        count: totals.withdrawals.count,
        gross: totals.withdrawals.grossCents / 100,
        net: totals.withdrawals.netCents / 100,
        missing_net: totals.withdrawals.missingNet,
      },
    },
    findings: findings.slice(0, FINDINGS_LIMIT),
  });
}
