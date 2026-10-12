import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  GATEWAYS,
  GATEWAY_IDS,
  isLedgerGateway,
  resolveActiveGateway,
} from '../../../../modules/packs/gateway';
import { gatewayEnabled } from '../../../../modules/packs/gateway-deposit';
import {
  withdrawalsEnabled,
  withdrawalsPausedUntil,
} from '../../../../modules/packs/gateway-withdrawal';
import {
  resolvePacks,
  type GatewayDeposits,
} from '../../../../modules/packs/facets';
import {
  paymentFxPair,
  paymentFxQuote,
  regionalDepositBand,
} from '../../../../modules/packs/payment-fx';

// GET /store/payments/config — what the storefront needs to render the top-up
// sheet and the withdrawal form for the ACTIVE gateway: its money bands and
// whether each channel is open. Public (publishable key only): nothing here
// is secret, and the sheet must know the floor before the customer types.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const gateway = await resolveActiveGateway(req.scope);
  const { limits } = GATEWAYS[gateway];
  const pausedUntil = withdrawalsPausedUntil();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    gateway,
    deposits_enabled: gatewayEnabled(),
    withdrawals_enabled: withdrawalsEnabled(),
    // The timed pause's end, so the withdrawal form can say when to come back.
    withdrawals_paused_until:
      pausedUntil !== null && Number.isFinite(pausedUntil)
        ? new Date(pausedUntil).toISOString()
        : null,
    deposit: { min_rm: limits.depositMin, max_rm: limits.depositMax },
    withdrawal: { min_rm: limits.withdrawalMin, max_rm: limits.withdrawalMax },
    regional: await regionalRails(req),
  });
}

/**
 * The regional rails open beside the active gateway (A3Pay: SGD), each with
 * its own band in its own currency and TODAY's customer rates, so the sheet
 * can show "S$100 -> RM 329.00" before anyone types. A rail with no firm
 * rate is reported closed: the money routes would refuse it anyway.
 */
async function regionalRails(req: MedusaRequest) {
  const packs = resolvePacks<GatewayDeposits>(req.scope);
  const rails: Record<string, unknown>[] = [];
  for (const id of GATEWAY_IDS) {
    if (isLedgerGateway(id)) continue;
    const deposits = gatewayEnabled(process.env, id);
    const withdrawals = withdrawalsEnabled(process.env, id);
    if (!deposits && !withdrawals) continue;
    const { currency, currencyLimits, limits: rmLimits } = GATEWAYS[id];
    const [row] = await packs.listFxRates(
      { pair: paymentFxPair(currency) },
      { take: 1 },
    );
    const quote = paymentFxQuote(row ?? null, currency);
    const priced = !('error' in quote);
    rails.push({
      gateway: id,
      currency,
      deposits_enabled: deposits && priced,
      withdrawals_enabled: withdrawals && priced,
      // Narrowed to what the RM band admits at today's rate, so the sheet
      // never offers an S$ amount the backend must refuse.
      deposit:
        priced && currencyLimits
          ? regionalDepositBand(quote, currencyLimits, rmLimits)
          : {
              min: currencyLimits?.depositMin ?? null,
              max: currencyLimits?.depositMax ?? null,
            },
      withdrawal: {
        min: currencyLimits?.withdrawalMin ?? null,
        max: currencyLimits?.withdrawalMax ?? null,
      },
      // RM per 1 unit of `currency`: credited on a top-up, debited on a payout.
      rate: priced
        ? { deposit: quote.depositRate, payout: quote.payoutRate }
        : null,
    });
  }
  return rails;
}
