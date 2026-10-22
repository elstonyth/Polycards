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
  type GatewayWithdrawals,
} from '../../../../modules/packs/facets';
import { channelStatus } from '../../../../modules/packs/withdrawal-controls';
import {
  paymentFxPair,
  paymentFxQuote,
  regionalDepositBand,
  regionalWithdrawalBand,
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
  const now = Date.now();
  // The admin's Withdraw switch / schedule closes withdrawals on every rail,
  // like the env's timed pause. Either one closed: the reopen time is the
  // later end, unknown (Infinity) if either has none.
  const admin = channelStatus(
    (await resolvePacks<GatewayWithdrawals>(req.scope).withdrawalControls())
      .withdrawals,
    now,
  );
  const envPausedUntil = withdrawalsPausedUntil(process.env, now);
  const ends = [
    ...(admin.open ? [] : [admin.reopens_at ?? Infinity]),
    ...(envPausedUntil === null ? [] : [envPausedUntil]),
  ];
  const pausedUntil = ends.length > 0 ? Math.max(...ends) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    gateway,
    deposits_enabled: gatewayEnabled(),
    withdrawals_enabled: admin.open && withdrawalsEnabled(),
    // Closed by the admin or a timed pause: the storefront's Withdraw button
    // answers with an "unavailable" popup instead of opening the form.
    withdrawals_unavailable: pausedUntil !== null,
    // The timed pause's end, so the withdrawal form can say when to come back.
    withdrawals_paused_until:
      pausedUntil !== null && Number.isFinite(pausedUntil)
        ? new Date(pausedUntil).toISOString()
        : null,
    deposit: { min_rm: limits.depositMin, max_rm: limits.depositMax },
    withdrawal: { min_rm: limits.withdrawalMin, max_rm: limits.withdrawalMax },
    regional: await regionalRails(req, admin.open),
  });
}

/**
 * The regional rails open beside the active gateway (A3Pay: SGD), each with
 * its own band in its own currency and TODAY's customer rates, so the sheet
 * can show "S$100 -> RM 329.00" before anyone types. A rail with no firm
 * rate is reported closed: the money routes would refuse it anyway.
 */
async function regionalRails(req: MedusaRequest, adminOpen: boolean) {
  const packs = resolvePacks<GatewayDeposits>(req.scope);
  const rails: Record<string, unknown>[] = [];
  for (const id of GATEWAY_IDS) {
    if (isLedgerGateway(id)) continue;
    const deposits = gatewayEnabled(process.env, id);
    const withdrawals = adminOpen && withdrawalsEnabled(process.env, id);
    if (!deposits && !withdrawals) continue;
    const { currency, currencyLimits, limits: rmLimits } = GATEWAYS[id];
    const [row] = await packs.listFxRates(
      { pair: paymentFxPair(currency) },
      { take: 1 },
    );
    const quote = paymentFxQuote(row ?? null, currency);
    const priced = !('error' in quote);
    const payoutBand =
      priced && currencyLimits
        ? regionalWithdrawalBand(quote, currencyLimits, rmLimits)
        : null;
    rails.push({
      gateway: id,
      currency,
      deposits_enabled: deposits && priced,
      withdrawals_enabled: withdrawals && priced,
      // Narrowed to what the RM band admits at today's rate, so the sheet
      // never offers an S$ amount the backend must refuse.
      deposit:
        priced && currencyLimits
          ? regionalDepositBand(
              quote,
              currencyLimits,
              rmLimits,
              GATEWAYS[id].payinNudgeCents,
            )
          : {
              min: currencyLimits?.depositMin ?? null,
              max: currencyLimits?.depositMax ?? null,
            },
      withdrawal: {
        min: currencyLimits?.withdrawalMin ?? null,
        max: currencyLimits?.withdrawalMax ?? null,
      },
      // The RM the withdrawal form may take for this rail today: its own
      // RM band narrowed to what pays inside the S$ band. The form enters RM
      // and otherwise judged it by the ACTIVE gateway's band.
      ...(payoutBand
        ? {
            withdrawal_rm: { min_rm: payoutBand.min, max_rm: payoutBand.max },
          }
        : {}),
      // RM per 1 unit of `currency`: credited on a top-up, debited on a payout.
      rate: priced
        ? { deposit: quote.depositRate, payout: quote.payoutRate }
        : null,
    });
  }
  return rails;
}
