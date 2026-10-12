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
  PAYMENT_FX_MAX_MARKUP_SHARE,
  SGD_MYR_PAIR,
  paymentFxQuote,
  type PaymentFxRow,
} from '../../../../modules/packs/payment-fx';
import { reqReason } from '../../rewards-settings/validate';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// GET/POST /admin/payments/fx — the SGD->RM conversion behind A3Pay
// (payment-fx.ts). The mid rate comes from the daily feed or an admin
// override; the MARKUP is our spread in RM per S$1, applied both ways:
// deposits credit at mid - markup, payouts pay at mid + markup.
//
// GET also reports what the spread has earned: for every settled SGD row,
// the RM it would have been at the mid (gateway_amount x fx_mid) against the
// RM actually credited or debited.

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
async function earnings(scope: AuthenticatedMedusaRequest['scope']) {
  const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
    raw: (sql: string) => Promise<{ rows: Record<string, string | null>[] }>;
  };
  const { rows } = await pg.raw(`
    SELECT
      (SELECT count(*) FROM gateway_deposit d
         WHERE d.currency = 'SGD' AND d.status = 'settled' AND d.deleted_at IS NULL) AS deposit_count,
      (SELECT coalesce(sum(
           d.gateway_amount * coalesce(d.amount_settled, d.amount_requested)
             / nullif(d.amount_requested, 0) * d.fx_mid
           - coalesce(d.amount_settled, d.amount_requested)), 0)
         FROM gateway_deposit d
         WHERE d.currency = 'SGD' AND d.status = 'settled' AND d.deleted_at IS NULL) AS deposit_rm,
      (SELECT count(*) FROM gateway_withdrawal w
         WHERE w.currency = 'SGD' AND w.status = 'settled' AND w.deleted_at IS NULL) AS payout_count,
      (SELECT coalesce(sum(
           w.amount
           - w.gateway_amount * coalesce(w.amount_settled, w.amount)
             / nullif(w.amount, 0) * w.fx_mid), 0)
         FROM gateway_withdrawal w
         WHERE w.currency = 'SGD' AND w.status = 'settled' AND w.deleted_at IS NULL) AS payout_rm
  `);
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
  const packs = resolvePacks<Packs>(req.scope);
  const [row] = (await packs.listFxRates(
    { pair: SGD_MYR_PAIR },
    { take: 1 },
  )) as (PaymentFxRow & { source?: string })[];
  const quote = paymentFxQuote(row ?? null, 'SGD');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    pair: SGD_MYR_PAIR,
    feed_rate: row && Number(row.rate) > 0 ? Number(row.rate) : null,
    source: row?.source ?? null,
    fetched_at: row?.fetched_at ?? null,
    manual_override: row?.manual_override ?? false,
    manual_rate: row?.manual_rate != null ? Number(row.manual_rate) : null,
    markup: Number(row?.markup ?? 0),
    max_markup_share: PAYMENT_FX_MAX_MARKUP_SHARE,
    quote: 'error' in quote ? null : quote,
    quote_error: 'error' in quote ? quote.error : null,
    earnings: await earnings(req.scope),
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
  const reason = reqReason(body);
  const markup = number(body.markup, 'markup');
  const manualOverride = body.manual_override === true;
  const manualRate =
    body.manual_rate === null ||
    body.manual_rate === undefined ||
    body.manual_rate === ''
      ? null
      : number(body.manual_rate, 'manual_rate');

  // An SGD->MYR rate lives around 3.0-3.6. Generous bounds, still enough to
  // stop a fat-fingered 330 or 0.33 from repricing every SGD payment.
  if (manualRate !== null && (manualRate < 1 || manualRate > 10)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'manual_rate' must be between 1 and 10 (RM per S$1).",
    );
  }
  if (manualOverride && manualRate === null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'manual_rate' is required when 'manual_override' is on.",
    );
  }
  const packs = resolvePacks<Packs>(req.scope);
  const [row] = (await packs.listFxRates(
    { pair: SGD_MYR_PAIR },
    { take: 1 },
  )) as PaymentFxRow[];
  const mid = manualOverride ? (manualRate as number) : Number(row?.rate ?? 0);
  const ceiling = mid > 0 ? mid * PAYMENT_FX_MAX_MARKUP_SHARE : 1;
  if (markup < 0 || markup > ceiling) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'markup' must be between 0 and ${ceiling.toFixed(4)} RM per S$1.`,
    );
  }

  await req.scope.resolve<PacksModuleService>(PACKS_MODULE).editPaymentFx({
    pair: SGD_MYR_PAIR,
    markup,
    manualOverride,
    manualRate,
    adminId: req.auth_context.actor_id,
    reason,
  });
  await GET(req, res);
}
