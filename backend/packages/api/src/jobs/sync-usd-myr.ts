import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { FX_USD_MYR_URL, resolveFxRateInfo } from '../modules/packs/pricing';
import { PAYMENT_FX_MAX_AGE_MS } from '../modules/packs/payment-fx';
import { fetchPaymentFx, PAYMENT_FX_MAX_JUMP } from './sync-payment-fx';

// USD->MYR, the rate behind every card price: sell-backs, opens, deliveries,
// coin flip. It used to be fetched once a day at the start of the
// PriceCharting sweep, from one feed, with no sanity band and only a warn line
// on failure (audit 2026-11-11). Now it runs hourly on its own: ECB (frankfurter)
// first, as before, then Coinbase when ECB fails. Each answer is banded and
// jump-guarded the way sync-payment-fx guards SGD. Problems are logged only:
// no Telegram alert (owner 2026-11-11).
//
// During an outage, sell-backs keep pricing on the last good rate by design:
// the same rate prices opens, deliveries and coin flip, so refusing on a stale
// rate would stop all of them.

/** RM per US$1 a feed may answer. Outside it, the feed is broken. */
export const USD_MYR_BAND = { min: 3, max: 6 };
export const USD_MYR_FALLBACK_URL =
  process.env.FX_USD_MYR_FALLBACK_URL ??
  'https://api.coinbase.com/v2/exchange-rates?currency=USD';
/** A pin this far from the market is logged: sell-backs pay off-market. */
export const USD_MYR_PIN_DRIFT_MAX = 0.01;
const WHERE = 'Admin → Storefront → Pricing — exchange rate (USD → MYR)';

export default async function syncUsdMyrJob(
  container: MedusaContainer,
): Promise<void> {
  await syncUsdMyr(container);
  await recordFxDay(container);
}

export const FX_DAY_UPSERT_SQL =
  'insert into fx_rate_day (pair, day, rate, recorded_at) values (?, ?, ?, now()) ' +
  'on conflict (pair, day) do update set rate = excluded.rate, recorded_at = now()';

/**
 * Save today's (MYT) effective rate in fx_rate_day so a report on a past day
 * prices it at that day's rate. Runs after every sync attempt, so a pin or the
 * last good rate is still saved on a day every feed fails. Never throws: a
 * missed save only means that day falls back to a neighbouring one.
 */
export async function recordFxDay(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const { rate, firm } = await resolveFxRateInfo(packs);
    // The display fallback is a constant nobody set: never record it.
    if (!firm) return;
    const day = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
    });
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
      raw: (sql: string, bindings: unknown[]) => Promise<unknown>;
    };
    await pg.raw(FX_DAY_UPSERT_SQL, ['USD_MYR', day, rate]);
  } catch (e) {
    logger.warn(
      `[sync-usd-myr] today's rate not saved to fx_rate_day: ${(e as Error).message}`,
    );
  }
}

async function syncUsdMyr(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  let got: Awaited<ReturnType<typeof fetchPaymentFx>> | null = null;
  for (const url of [FX_USD_MYR_URL, USD_MYR_FALLBACK_URL]) {
    try {
      const answer = await fetchPaymentFx('USD', { url, ...USD_MYR_BAND });
      // A feed still serving an old day (ECB stuck) is a failed feed too:
      // ECB's longest holiday gap is ~5.6 days, so a week is broken.
      if (Date.now() - answer.asOf.getTime() > PAYMENT_FX_MAX_AGE_MS)
        throw new Error(
          `stale, dated ${answer.asOf.toISOString().slice(0, 10)}`,
        );
      got = answer;
      break;
    } catch (e) {
      logger.warn(
        `[sync-usd-myr] ${url.split('/')[2]} failed: ${(e as Error).message}`,
      );
    }
  }
  if (!got) {
    const note = `USD->MYR: every feed failed, card prices and sell-backs keep the last-known rate. Check the feeds, or pin a manual rate in ${WHERE}.`;
    logger.warn(`[sync-usd-myr] ${note}`);
    return;
  }

  try {
    const { rate, asOf, source } = got;
    const [row] = await packs.listFxRates({ pair: 'USD_MYR' }, { take: 1 });
    // Measured against a pin while one is set, so pinning near the market is
    // how the feed is let back in after a real move bigger than the guard.
    const pinned = row?.manual_override ? Number(row.manual_rate) : NaN;
    const previous =
      Number.isFinite(pinned) && pinned > 0 ? pinned : Number(row?.rate);
    if (
      Number.isFinite(previous) &&
      previous > 0 &&
      Math.abs(rate / previous - 1) > PAYMENT_FX_MAX_JUMP
    ) {
      const note = `USD->MYR feed (${source}) says ${rate}, ${((rate / previous - 1) * 100).toFixed(1)}% from the stored ${previous}. NOT applied, the last rate stays. If the move is real, pin a manual rate near it in ${WHERE}.`;
      logger.error(`[sync-usd-myr] ${note}`);
      return;
    }
    if (
      Number.isFinite(pinned) &&
      pinned > 0 &&
      Math.abs(rate / pinned - 1) > USD_MYR_PIN_DRIFT_MAX
    ) {
      const note = `USD->MYR is pinned at ${pinned} but the feed (${source}) says ${rate}, ${((rate / pinned - 1) * 100).toFixed(2)}% away, so card prices and sell-backs are off-market. Update or remove the pin in ${WHERE}.`;
      logger.error(`[sync-usd-myr] ${note}`);
    }
    if (row)
      await packs.updateFxRates([
        { id: row.id, rate, source, fetched_at: asOf },
      ]);
    else
      await packs.createFxRates([
        { pair: 'USD_MYR', rate, source, fetched_at: asOf },
      ]);
    logger.info(
      `[sync-usd-myr] USD->MYR = ${rate} from ${source} (as of ${asOf.toISOString().slice(0, 16)}Z)`,
    );
  } catch (e) {
    logger.warn(
      `[sync-usd-myr] write failed, keeping last-known: ${(e as Error).message}`,
    );
  }
}

export const config = { name: 'sync-usd-myr', schedule: '10 * * * *' };
