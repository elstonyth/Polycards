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
// Writes rate / source / fetched_at only. The admin's fee and manual
// override live on the same row and are never touched here.

/**
 * The largest move one run may make to a stored feed rate. SGD/MYR moves a
 * fraction of a percent in a day; a bigger jump in an hour is a broken feed
 * (a wrong pair, a decimal slip) far more often than a market — and a wrong
 * rate here mis-prices every top-up and payout. Refused and alerted; an admin
 * can pin a manual rate if the move is real.
 */
export const PAYMENT_FX_MAX_JUMP = 0.05;

/** Repeat alerts at most this often (feed down, jump refused, pin drifted). */
const FX_ALERT_MUTE_MS = 6 * 60 * 60 * 1000;

/**
 * The smallest pin-vs-market drift worth an alert. A pinned rate loses money
 * once the market moves past the fee on the losing side; with the fee off
 * (0%) any drift does, but alerting on noise every run helps nobody.
 */
export const PAYMENT_FX_PIN_DRIFT_MIN = 0.005;

/**
 * One feed's rate for `currency` -> MYR, sanity-banded. Two shapes:
 *   Coinbase    { data: { currency, rates: { MYR: "3.18…" } } }  (live, no date)
 *   frankfurter { date: "2026-10-12", rates: { MYR: 3.19 } }      (ECB, daily)
 */
export async function fetchPaymentFx(
  currency: string,
  feed: { url: string; min: number; max: number; quotes?: string },
): Promise<{ rate: number; asOf: Date; source: string }> {
  const resp = await fetch(feed.url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`FX feed: HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    base?: unknown;
    date?: string;
    rates?: { MYR?: unknown };
    data?: { currency?: unknown; rates?: { MYR?: unknown } };
  };
  // Both shapes name the currency they quote FROM (Coinbase data.currency,
  // frankfurter base). A missing or different label is a wrong pair, however
  // plausible its number looks.
  const quoted = data?.data ? data.data.currency : data?.base;
  if (quoted !== (feed.quotes ?? currency))
    throw new Error(`FX feed: answered for ${String(quoted)}`);
  const raw = data?.data ? data.data.rates?.MYR : data?.rates?.MYR;
  // Only a number or a numeric string is a rate: Number(true) is 1.
  const rate =
    typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
      ? Number(raw)
      : NaN;
  // A rate outside the currency's band is a broken feed, not a market move.
  if (!Number.isFinite(rate) || rate < feed.min || rate > feed.max)
    throw new Error(`FX feed: no usable ${currency}->MYR`);
  // A dated feed (ECB) is aged from its OWN publication day, so the
  // staleness guard measures how old the rate is, not how recently we
  // fetched a feed that may keep serving an old day. A live feed is now.
  const now = new Date();
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(data.date ?? '')
    ? new Date(`${data.date}T00:00:00Z`)
    : null;
  // A date past tomorrow is a broken feed. Tomorrow's (a timezone ahead) is
  // clamped to now, or a future stamp would switch the staleness guard off.
  if (dated && dated.getTime() > now.getTime() + 86_400_000)
    throw new Error(`FX feed: dated in the future (${data.date})`);
  const asOf = dated && dated < now ? dated : now;
  const source = data?.data ? 'coinbase' : 'frankfurter';
  return { rate: Math.round(rate * 1e6) / 1e6, asOf, source };
}

/** A feed's host for the log, without letting a malformed URL throw. */
const feedHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'an invalid URL';
  }
};

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
        got = await fetchPaymentFx(currency, {
          ...feed,
          url,
          // A proxy fallback names its own currency (USDT is priced by USD).
          quotes: url === feed.fallbackUrl ? feed.fallbackQuotes : undefined,
        });
        break;
      } catch (e) {
        logger.warn(
          `[sync-payment-fx] ${currency} feed ${feedHost(url)} failed: ${(e as Error).message}`,
        );
      }
    }
    if (!got) {
      const note = `${currency}->MYR: every feed failed, keeping last-known. The rail pauses itself once that rate is too old; check the feeds, or pin a manual rate in Admin → Settlement (the ${currency} tab).`;
      logger.warn(`[sync-payment-fx] ${note}`);
      void alertOps(container, `fx-feed-down:${currency}`, note, {
        muteMs: FX_ALERT_MUTE_MS,
      });
      continue;
    }
    try {
      const { rate, asOf, source } = got;
      const [row] = await packs.listFxRates({ pair }, { take: 1 });
      // Measured against the admin's pinned rate while one is set. After a
      // real move bigger than the guard (a long feed outage), pinning a
      // manual rate near the market is how the feed is let back in.
      const pinned = row?.manual_override ? Number(row.manual_rate) : NaN;
      const previous =
        Number.isFinite(pinned) && pinned > 0 ? pinned : Number(row?.rate);
      if (
        Number.isFinite(previous) &&
        previous > 0 &&
        Math.abs(rate / previous - 1) > PAYMENT_FX_MAX_JUMP
      ) {
        const note = `${currency}->MYR feed (${source}) says ${rate}, ${((rate / previous - 1) * 100).toFixed(1)}% from the stored ${previous} — NOT applied; the last rate stays. If the move is real, pin a manual rate near it in Admin → Settlement (the ${currency} tab): the feed is measured against a pinned rate, so it resumes once within ${PAYMENT_FX_MAX_JUMP * 100}%.`;
        logger.error(`[sync-payment-fx] ${note}`);
        void alertOps(container, `fx-jump:${currency}`, note, {
          muteMs: FX_ALERT_MUTE_MS,
        });
        continue;
      }
      // A pin never expires, so say when the market has moved past the fee on
      // the side it loses on: above the pin, payouts are too cheap; below it,
      // top-ups are credited too much.
      if (Number.isFinite(pinned) && pinned > 0) {
        const drift = rate / pinned - 1;
        const losingFee = row?.fee_enabled
          ? Number(
              drift > 0 ? row.payout_fee_percent : row.deposit_fee_percent,
            ) / 100 || 0
          : 0;
        if (Math.abs(drift) > Math.max(PAYMENT_FX_PIN_DRIFT_MIN, losingFee)) {
          const note = `${currency}->MYR is pinned at ${pinned} but the feed (${source}) says ${rate}, ${(drift * 100).toFixed(2)}% away and past the fee, so every ${drift > 0 ? 'payout' : 'top-up'} now loses money. Update or remove the pin in Admin → Settlement (the ${currency} tab).`;
          logger.error(`[sync-payment-fx] ${note}`);
          void alertOps(container, `fx-pin-drift:${currency}`, note, {
            muteMs: FX_ALERT_MUTE_MS,
          });
        }
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
