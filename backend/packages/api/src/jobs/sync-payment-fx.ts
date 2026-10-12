import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { SGD_MYR_PAIR } from '../modules/packs/payment-fx';

// The SGD->MYR mid rate behind A3Pay conversions (payment-fx.ts). Separate
// from the daily sync-market-prices run (USD_MYR) so a slow PriceCharting pass
// can never hold the payment rate back, and run every 6h so one failed fetch
// is not a day-long gap. ECB (frankfurter's source) publishes on working days;
// payment-fx.ts tolerates 4 days of staleness before it stops quoting.
//
// Writes rate / source / fetched_at only. The admin's markup and manual
// override live on the same row and are never touched here.

export const FX_SGD_MYR_URL =
  process.env.FX_SGD_MYR_URL ??
  'https://api.frankfurter.dev/v1/latest?from=SGD&to=MYR';

export async function fetchSgdMyr(
  url: string = FX_SGD_MYR_URL,
): Promise<{ rate: number; asOf: Date }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await resp.json()) as {
    date?: string;
    rates?: { MYR?: number };
  };
  const rate = data?.rates?.MYR;
  // An SGD->MYR rate outside 1-10 is a broken feed, not a market move.
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate < 1 ||
    rate > 10
  )
    throw new Error('FX feed: no usable SGD->MYR');
  // The rate's OWN date (ECB publication day), so the staleness guard in
  // payment-fx.ts measures how old the rate is — not how recently we managed
  // to fetch a feed that may keep serving an old day. Unparseable = now.
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
  try {
    const { rate, asOf } = await fetchSgdMyr();
    const [row] = await packs.listFxRates({ pair: SGD_MYR_PAIR }, { take: 1 });
    if (row)
      await packs.updateFxRates([
        { id: row.id, rate, source: 'frankfurter', fetched_at: asOf },
      ]);
    else
      await packs.createFxRates([
        { pair: SGD_MYR_PAIR, rate, source: 'frankfurter', fetched_at: asOf },
      ]);
    logger.info(
      `[sync-payment-fx] SGD->MYR = ${rate} (as of ${asOf.toISOString().slice(0, 10)})`,
    );
  } catch (e) {
    logger.warn(
      `[sync-payment-fx] failed, keeping last-known: ${(e as Error).message}`,
    );
  }
}

export const config = { name: 'sync-payment-fx', schedule: '15 */6 * * *' };
