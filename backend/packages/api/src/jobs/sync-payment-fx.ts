import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  PAYMENT_FX_FEEDS,
  paymentFxPair,
} from '../modules/packs/payment-fx';

// The mid rates behind regional-gateway conversions (payment-fx.ts), one per
// currency in PAYMENT_FX_FEEDS that has a feed URL (SGD today; a currency
// without one — USDT — is priced by an admin manual rate). Separate from the
// daily sync-market-prices run (USD_MYR) so a slow PriceCharting pass can
// never hold a payment rate back, and run every 6h so one failed fetch is not
// a day-long gap. ECB (frankfurter's source) publishes on working days;
// payment-fx.ts tolerates PAYMENT_FX_MAX_AGE_MS of staleness.
//
// Writes rate / source / fetched_at only. The admin's markup and manual
// override live on the same row and are never touched here.

/** One frankfurter-shaped feed: { date, rates: { MYR } }, sanity-banded. */
export async function fetchPaymentFx(
  currency: string,
  feed: { url: string; min: number; max: number },
): Promise<{ rate: number; asOf: Date }> {
  const resp = await fetch(feed.url, { signal: AbortSignal.timeout(10_000) });
  const data = (await resp.json()) as {
    date?: string;
    rates?: { MYR?: number };
  };
  const rate = data?.rates?.MYR;
  // A rate outside the currency's band is a broken feed, not a market move.
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate < feed.min ||
    rate > feed.max
  )
    throw new Error(`FX feed: no usable ${currency}->MYR`);
  // The rate's OWN date (ECB publication day), so the staleness guard
  // measures how old the rate is — not how recently we managed to fetch a
  // feed that may keep serving an old day. Unparseable = now.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(data.date ?? '')
    ? new Date(`${data.date}T00:00:00Z`)
    : new Date();
  return { rate, asOf };
}

export default async function syncPaymentFxJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  for (const [currency, feed] of Object.entries(PAYMENT_FX_FEEDS)) {
    if (!feed.url) continue;
    const pair = paymentFxPair(currency);
    try {
      const { rate, asOf } = await fetchPaymentFx(currency, {
        ...feed,
        url: feed.url,
      });
      const [row] = await packs.listFxRates({ pair }, { take: 1 });
      if (row)
        await packs.updateFxRates([
          { id: row.id, rate, source: 'frankfurter', fetched_at: asOf },
        ]);
      else
        await packs.createFxRates([
          { pair, rate, source: 'frankfurter', fetched_at: asOf },
        ]);
      logger.info(
        `[sync-payment-fx] ${currency}->MYR = ${rate} (as of ${asOf.toISOString().slice(0, 10)})`,
      );
    } catch (e) {
      logger.warn(
        `[sync-payment-fx] ${currency} failed, keeping last-known: ${(e as Error).message}`,
      );
    }
  }
}

export const config = { name: 'sync-payment-fx', schedule: '15 */6 * * *' };
