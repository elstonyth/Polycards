import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import {
  resolvePacks,
  type GatewayReports,
} from '../../../../modules/packs/facets';
import {
  PAYMENT_FX_FEEDS,
  PAYMENT_FX_MAX_FEE_PERCENT,
  paymentFxPair,
  paymentFxQuote,
  type PaymentFxRow,
} from '../../../../modules/packs/payment-fx';
import { REGIONAL_CURRENCIES } from '../../../../modules/packs/gateway';
import { reqReason } from '../../rewards-settings/validate';
import { paymentCurrencyParam } from '../../../utils/payment-currency';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// GET/POST /admin/payments/fx?currency=SGD — the conversion behind a
// regional gateway (payment-fx.ts), one currency per call (default SGD; any
// currency in REGIONAL_CURRENCIES). The mid rate comes from the feed or an
// admin override; the MARKUP is our spread in RM per unit, applied both ways:
// deposits credit at mid - markup, payouts pay at mid + markup.
//
// GET also reports what the spread has earned: for every settled row in that
// currency, the RM it would have been at the mid against the RM actually
// credited or debited.

/** The currency a call is about: ?currency= / body.currency, default SGD. */
function currencyOf(value: unknown): string {
  return paymentCurrencyParam(value, REGIONAL_CURRENCIES) ?? 'SGD';
}

type Packs = Pick<PacksModuleService, 'listFxRates' | 'editPaymentFx'> &
  Pick<GatewayReports, 'listGatewayDeposits' | 'listGatewayWithdrawals'>;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * What the spread has earned, summed in SQL over every settled SGD row (no row
 * cap). The S$ actually moved is the locked S$ scaled by settled/locked RM, so
 * a payment settled at a different sum than quoted (a requery of a nudged or
 * partial payment) is valued at what really moved, not at the quote.
 *   top-up: S$ paid x mid  -  RM credited
 *   payout: RM debited     -  S$ paid out x mid
 */
async function earnings(
  scope: AuthenticatedMedusaRequest['scope'],
  currency: string,
) {
  const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
    raw: (
      sql: string,
      bindings: Record<string, string>,
    ) => Promise<{ rows: Record<string, string | null>[] }>;
  };
  const { rows } = await pg.raw(`
    SELECT
      (SELECT count(*) FROM gateway_deposit d
         WHERE d.currency = :currency AND d.status = 'settled' AND d.deleted_at IS NULL) AS deposit_count,
      (SELECT coalesce(sum(
           d.gateway_amount * coalesce(d.amount_settled, d.amount_requested)
             / nullif(d.amount_requested, 0) * d.fx_mid
           - coalesce(d.amount_settled, d.amount_requested)), 0)
         FROM gateway_deposit d
         WHERE d.currency = :currency AND d.status = 'settled' AND d.deleted_at IS NULL) AS deposit_rm,
      (SELECT count(*) FROM gateway_withdrawal w
         WHERE w.currency = :currency AND w.status = 'settled' AND w.deleted_at IS NULL) AS payout_count,
      (SELECT coalesce(sum(
           w.amount
           - w.gateway_amount * coalesce(w.amount_settled, w.amount)
             / nullif(w.amount, 0) * w.fx_mid), 0)
         FROM gateway_withdrawal w
         WHERE w.currency = :currency AND w.status = 'settled' AND w.deleted_at IS NULL) AS payout_rm
  `,
    { currency },
  );
  const r = rows[0] ?? {};
  const deposits = round2(Number(r.deposit_rm ?? 0));
  const payouts = round2(Number(r.payout_rm ?? 0));
  return {
    deposits: { count: Number(r.deposit_count ?? 0), rm: deposits },
    payouts: { count: Number(r.payout_count ?? 0), rm: payouts },
    total_rm: round2(deposits + payouts),
  };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const currency = currencyOf(
    (req.body as Record<string, unknown> | undefined)?.currency ??
      req.query?.currency,
  );
  const pair = paymentFxPair(currency);
  const packs = resolvePacks<Packs>(req.scope);
  const [row] = (await packs.listFxRates(
    { pair },
    { take: 1 },
  )) as (PaymentFxRow & { source?: string })[];
  const quote = paymentFxQuote(row ?? null, currency);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    currency,
    pair,
    unit: PAYMENT_FX_FEEDS[currency]?.unit ?? `1 ${currency}`,
    manual_band: {
      min: PAYMENT_FX_FEEDS[currency]?.min ?? null,
      max: PAYMENT_FX_FEEDS[currency]?.max ?? null,
    },
    feed_rate: row && Number(row.rate) > 0 ? Number(row.rate) : null,
    source: row?.source ?? null,
    fetched_at: row?.fetched_at ?? null,
    manual_override: row?.manual_override ?? false,
    manual_rate: row?.manual_rate != null ? Number(row.manual_rate) : null,
    fee_enabled: row?.fee_enabled ?? null,
    deposit_fee_percent: Number(row?.deposit_fee_percent ?? 0),
    payout_fee_percent: Number(row?.payout_fee_percent ?? 0),
    max_fee_percent: PAYMENT_FX_MAX_FEE_PERCENT,
    quote: 'error' in quote ? null : quote,
    quote_error: 'error' in quote ? quote.error : null,
    earnings: await earnings(req.scope, currency),
  });
}

const number = (value: unknown, field: string): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a number.`,
    );
  }
  return n;
};

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const currency = currencyOf(body.currency);
  const pair = paymentFxPair(currency);
  const band = PAYMENT_FX_FEEDS[currency] ?? { min: 0.0001, max: 1000 };
  const reason = reqReason(body);
  if (typeof body.fee_enabled !== 'boolean') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'fee_enabled' must be true or false.",
    );
  }
  const feeEnabled = body.fee_enabled;
  // Kept while the fee is switched off, so switching it back on restores them.
  const fees = (['deposit_fee_percent', 'payout_fee_percent'] as const).map(
    (field) => {
      const pct = number(body[field], field);
      if (pct < 0 || pct > PAYMENT_FX_MAX_FEE_PERCENT) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `'${field}' must be between 0 and ${PAYMENT_FX_MAX_FEE_PERCENT} (percent).`,
        );
      }
      return pct;
    },
  );
  const manualOverride = body.manual_override === true;
  const manualRate =
    body.manual_rate === null ||
    body.manual_rate === undefined ||
    body.manual_rate === ''
      ? null
      : number(body.manual_rate, 'manual_rate');

  // Per-currency sanity band (PAYMENT_FX_FEEDS): SGD->MYR lives around
  // 3.0-3.6, so 1-10 still stops a fat-fingered 330 or 0.33 from repricing
  // every SGD payment.
  if (
    manualRate !== null &&
    (manualRate < band.min || manualRate > band.max)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'manual_rate' must be between ${band.min} and ${band.max} (RM per 1 ${currency}).`,
    );
  }
  if (manualOverride && manualRate === null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'manual_rate' is required when 'manual_override' is on.",
    );
  }
  await req.scope.resolve<PacksModuleService>(PACKS_MODULE).editPaymentFx({
    pair,
    feeEnabled,
    depositFeePercent: fees[0],
    payoutFeePercent: fees[1],
    manualOverride,
    manualRate,
    adminId: req.auth_context.actor_id,
    reason,
  });
  await GET(req, res);
}
