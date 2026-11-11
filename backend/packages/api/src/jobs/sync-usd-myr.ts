import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { FX_USD_MYR_URL } from '../modules/packs/pricing';
import { alertOps } from '../modules/packs/ops-alert';
import { fetchPaymentFx, PAYMENT_FX_MAX_JUMP } from './sync-payment-fx';

// USD->MYR, the rate behind every card price: sell-backs, opens, deliveries,
// coin flip. It used to be fetched once a day at the start of the
// PriceCharting sweep, from one feed, with no sanity band and only a warn line
// on failure (audit 2026-11-11). Now it runs hourly on its own: ECB (frankfurter)
// first, as before, then Coinbase when ECB fails. Each answer is banded and
// jump-guarded the way sync-payment-fx guards SGD, and staff are alerted.
//
// During an outage, sell-backs keep pricing on the last good rate on purpose
// (owner 2026-11-11: sell-backs must keep working). The alert is the fence,
// not a refusal.

/** RM per US$1 a feed may answer. Outside it, the feed is broken. */
export const USD_MYR_BAND = { min: 3, max: 6 };
export const USD_MYR_FALLBACK_URL =
  process.env.FX_USD_MYR_FALLBACK_URL ??
  'https://api.coinbase.com/v2/exchange-rates?currency=USD';
/** A pin this far from the market gets an alert: sell-backs pay off-market. */
export const USD_MYR_PIN_DRIFT_MAX = 0.01;
const ALERT_MUTE_MS = 6 * 60 * 60 * 1000;
const WHERE = 'Admin → Storefront → Pricing — exchange rate (USD → MYR)';

export default async function syncUsdMyrJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const alert = (tag: string, note: string) =>
    void alertOps(container, `fx-usd-myr:${tag}`, note, {
      muteMs: ALERT_MUTE_MS,
    });

  let got: Awaited<ReturnType<typeof fetchPaymentFx>> | null = null;
  for (const url of [FX_USD_MYR_URL, USD_MYR_FALLBACK_URL]) {
    try {
      got = await fetchPaymentFx('USD', { url, ...USD_MYR_BAND });
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
    alert('feed-down', note);
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
      alert('jump', note);
      return;
    }
    if (
      Number.isFinite(pinned) &&
      pinned > 0 &&
      Math.abs(rate / pinned - 1) > USD_MYR_PIN_DRIFT_MAX
    ) {
      const note = `USD->MYR is pinned at ${pinned} but the feed (${source}) says ${rate}, ${((rate / pinned - 1) * 100).toFixed(2)}% away, so card prices and sell-backs are off-market. Update or remove the pin in ${WHERE}.`;
      logger.error(`[sync-usd-myr] ${note}`);
      alert('pin-drift', note);
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
