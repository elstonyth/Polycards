import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { PAYMENT_FX_FEEDS, paymentFxPair } from '../modules/packs/payment-fx';
import { alertOps } from '../modules/packs/ops-alert';

// The mid rates behind regional-gateway conversions (payment-fx.ts), one per
// currency in PAYMENT_FX_FEEDS that has a feed URL (SGD today). Separate from
// the daily sync-market-prices run (USD_MYR) so a slow PriceCharting pass can
// never hold a payment rate back.
//
// HOURLY (operator decision, 2026-10-13): the primary feed is Coinbase's
// public fiat rates, which move through the day; ECB via frankfurter
// publishes once per working day and is the fallback when the primary fails
// or answers nonsense. payment-fx.ts tolerates PAYMENT_FX_MAX_AGE_MS of
// staleness, so a run of failed hours only ages the last good rate.
//
// Writes rate / source / fetched_at only. The admin's markup and manual
// override live on the same row and are never touched here.

/**
 * The largest move one run may make to a stored feed rate. SGD/MYR moves a
 * fraction of a percent in a day; a bigger jump in an hour is a broken feed
 * (a wrong pair, a decimal slip) far more often than a market — and a wrong
 * rate here mis-prices every top-up and payout. Refused and alerted; an admin
 * can pin a manual rate if the move is real.
 */
export const PAYMENT_FX_MAX_JUMP = 0.05;

/**
 * One feed's rate for `currency` -> MYR, sanity-banded. Two shapes:
 *   Coinbase    { data: { currency, rates: { MYR: "3.18…" } } }  (live, no date)
 *   frankfurter { date: "2026-10-12", rates: { MYR: 3.19 } }      (ECB, daily)
 */
export async function fetchPaymentFx(
  currency: string,
  feed: { url: string; min: number; max: number },
): Promise<{ rate: number; asOf: Date; source: string }> {
  const resp = await fetch(feed.url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`FX feed: HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    date?: string;
    rates?: { MYR?: unknown };
    data?: { currency?: string; rates?: { MYR?: unknown } };
  };
  if (data?.data?.currency && data.data.currency !== currency)
    throw new Error(`FX feed: answered for ${data.data.currency}`);
  const rate = Number(data?.data?.rates?.MYR ?? data?.rates?.MYR);
  // A rate outside the currency's band is a broken feed, not a market move.
  if (!Number.isFinite(rate) || rate < feed.min || rate > feed.max)
    throw new Error(`FX feed: no usable ${currency}->MYR`);
  // A dated feed (ECB) is aged from its OWN publication day, so the
  // staleness guard measures how old the rate is, not how recently we
  // fetched a feed that may keep serving an old day. A live feed is now.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(data.date ?? '')
    ? new Date(`${data.date}T00:00:00Z`)
    : new Date();
  const source = data?.data ? 'coinbase' : 'frankfurter';
  return { rate: Math.round(rate * 1e6) / 1e6, asOf, source };
}

export default async function syncPaymentFxJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  for (const [currency, feed] of Object.entries(PAYMENT_FX_FEEDS)) {
    if (!feed.url) continue;
    const pair = paymentFxPair(currency);
    let got: Awaited<ReturnType<typeof fetchPaymentFx>> | null = null;
    for (const url of [feed.url, feed.fallbackUrl]) {
      if (!url) continue;
      try {
        got = await fetchPaymentFx(currency, { ...feed, url });
        break;
      } catch (e) {
        logger.warn(
          `[sync-payment-fx] ${currency} feed ${new URL(url).hostname} failed: ${(e as Error).message}`,
        );
      }
    }
    if (!got) {
      logger.warn(
        `[sync-payment-fx] ${currency}: every feed failed, keeping last-known`,
      );
      continue;
    }
    try {
      const { rate, asOf, source } = got;
      const [row] = await packs.listFxRates({ pair }, { take: 1 });
      const previous = Number(row?.rate);
      if (
        Number.isFinite(previous) &&
        previous > 0 &&
        Math.abs(rate / previous - 1) > PAYMENT_FX_MAX_JUMP
      ) {
        const note = `${currency}->MYR feed (${source}) says ${rate}, ${((rate / previous - 1) * 100).toFixed(1)}% from the stored ${previous} — NOT applied; the last rate stays. If the move is real, pin a manual rate in Admin → Settlement.`;
        logger.error(`[sync-payment-fx] ${note}`);
        void alertOps(container, `fx-jump:${currency}`, note, {
          muteMs: 6 * 60 * 60 * 1000,
        });
        continue;
      }
      if (row)
        await packs.updateFxRates([
          { id: row.id, rate, source, fetched_at: asOf },
        ]);
      else
        await packs.createFxRates([{ pair, rate, source, fetched_at: asOf }]);
      logger.info(
        `[sync-payment-fx] ${currency}->MYR = ${rate} from ${source} (as of ${asOf.toISOString().slice(0, 16)}Z)`,
      );
    } catch (e) {
      logger.warn(
        `[sync-payment-fx] ${currency} failed, keeping last-known: ${(e as Error).message}`,
      );
    }
  }
}

export const config = { name: 'sync-payment-fx', schedule: '5 * * * *' };
