import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  checkBalance,
  gatewayConfigFor,
  GATEWAYS,
  LEDGER_CURRENCY,
} from '../../../../modules/packs/gateway';
import { gatewayEnabled } from '../../../../modules/packs/gateway-deposit';
import {
  paymentCurrencyParam,
  railGateway,
} from '../../../utils/payment-currency';

// GET /admin/payments/balance — the live merchant balance at the active gateway
// (money-path-accuracy-audit-2026-08-17 B3). checkBalance existed since the
// integration shipped and had exactly one caller: a CLI script. This gives the
// operator the payout float without logging into the gateway — the number that
// says whether a refused payout was PMT10013 (empty float) before support gets
// involved.
//
// Its OWN route, not a field on /settlement, deliberately: this is a live
// upstream call with a 20s worst case and its own failure modes, and the
// settlement report is a local read that must stay fast and must not 500
// because the gateway is down. Failure here is an ANSWER ("could not reach
// them"), reported as 200 + error so the dashboard renders the report beside a
// degraded balance card instead of an error page.
//
// Read-only and side-effect free upstream (§1.9), so polling it from a
// dashboard is safe. Admin-only (auto-protected /admin/* route).
//
// ?currency= picks the rail (default RM, the active gateway): SGD reads
// A3Pay's wallet, in S$. It is the Settlement page's ONLY wallet read — the
// audit panel used to read the same wallet a second time.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const currency = paymentCurrencyParam(req.query.currency) ?? LEDGER_CURRENCY;
  const gateway = await railGateway(req.scope, currency);
  const rail = { currency, gateway, label: GATEWAYS[gateway].label };

  if (!gatewayEnabled(process.env, gateway)) {
    res.json({ ...rail, enabled: false, balance: null, error: null });
    return;
  }

  try {
    const balance = await checkBalance(gatewayConfigFor(gateway));
    res.json({
      ...rail,
      enabled: true,
      balance: {
        currency_code: balance.currencyCode,
        current: balance.currentBalance,
        available: balance.availableBalance,
        t1: balance.t1Balance,
      },
      // A wallet the gateway did not report reads 0 here; say so beside it.
      error: balance.notes?.length ? balance.notes.join('; ') : null,
    });
  } catch (error) {
    // The message is ours/theirs (GatewayError text) — codes and HTTP status,
    // never the signed envelope — safe for an admin screen.
    res.json({
      ...rail,
      enabled: true,
      balance: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
