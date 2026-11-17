import type { FlagCountry } from '@/components/ui/country-flag';
import type { DepositMethod } from '@/lib/deposit-methods';
import {
  regionalCredit,
  regionalPayout,
  type PaymentLimits,
} from '@/lib/payment-limits';
import {
  openRails,
  regionalRailUi,
  type OpenRail,
  type RegionalRailUi,
} from '@/lib/regional-rails';

/**
 * The answer the top-up sheet and the withdraw form render: which rails a
 * customer may use, the band an amount must sit in, and whether the channel
 * is open. Pure — the gateway's answer (payment-limits.ts), the rails this
 * build knows (regional-rails.ts) and the RM channels (deposit-methods.ts) go
 * in; the forms only word and draw what comes out.
 */

/**
 * The band an amount field allows when nothing narrower applies: one cent
 * (the smallest amount there is) up to 10,000 — the mock gateway's cap, and
 * the ceiling for a regional rail that names none.
 */
export const DEPOSIT_BAND_FALLBACK = { min: 0.01, max: 10_000 } as const;

const PAUSED_HINT = 'Paused right now — your balance and cards are unaffected';

/**
 * One row of the "Choose a currency" step. The list is built from what the
 * backend reports open (getPaymentLimits) and what lib/regional-rails.ts
 * knows how to present, so a new rail (USDT next) needs no change here.
 */
export type CurrencyOption = {
  /** 'MYR', or a regional rail's currency code. */
  code: string;
  /** Shown after the name and in front of amounts. */
  symbol: string;
  /** The badge: which country's banks pay in this currency. */
  flag: FlagCountry;
  name: string;
  hint: string;
  /** Listed but not choosable (the RM gateway is paused). */
  disabled?: boolean;
};

export type DepositOffer = {
  /** The currency step's rows. */
  options: CurrencyOption[];
  /** The regional rail being paid through; undefined = paying in RM. */
  rail: OpenRail | undefined;
  /** The amount the customer pays, in the chosen currency. */
  band: { min: number; max: number };
  /** The RM channel is shut: no amount can be paid. */
  closed: boolean;
  /** The channels the payment can go through. */
  methods: readonly DepositMethod[] | RegionalRailUi['methods'];
  /** RM credited for a valid `paid` amount. */
  credit: (paid: number) => number;
};

/**
 * What the top-up sheet offers for `currency` (null = not chosen yet).
 * `gateway` is false on the mock path: RM only, the fallback band, never
 * closed.
 */
export function depositOffer(
  limits: PaymentLimits,
  methods: readonly DepositMethod[],
  currency: string | null,
  { gateway }: { gateway: boolean },
): DepositOffer {
  // The regional rails the backend has open AND priced (gateway path only),
  // and the one being paid through, if any. Undefined = paying in RM.
  const rails = gateway ? openRails(limits.regional, 'deposit') : [];
  const rail = rails.find((option) => option.currency === currency);
  const band = rail
    ? {
        min: Math.max(
          DEPOSIT_BAND_FALLBACK.min,
          rail.deposit.min ?? DEPOSIT_BAND_FALLBACK.min,
        ),
        max: rail.deposit.max ?? DEPOSIT_BAND_FALLBACK.max,
      }
    : gateway
      ? {
          min: Math.max(DEPOSIT_BAND_FALLBACK.min, limits.deposit.minRm),
          max: limits.deposit.maxRm,
        }
      : { ...DEPOSIT_BAND_FALLBACK };

  // Step 1's rows: RM always — marked paused, not hidden, when the admin has
  // closed RM top-ups, so the customer is told rather than left wondering —
  // then every open regional rail, then any closed one the backend still
  // reports, paused for the same reason.
  const rmPaused = gateway && !limits.depositsEnabled;
  const options: CurrencyOption[] = [
    {
      code: 'MYR',
      symbol: 'RM',
      flag: 'MY',
      name: 'Malaysian Ringgit',
      hint: rmPaused ? PAUSED_HINT : 'Online banking (FPX) · QR / e-wallet',
      disabled: rmPaused,
    },
    ...rails.map((option) => ({
      code: option.currency,
      symbol: option.ui.symbol,
      flag: option.ui.flag,
      name: option.ui.name,
      hint: `${option.ui.hint} · ${option.ui.unit} = RM ${option.rate.deposit.toFixed(4)}`,
    })),
    ...(gateway ? (limits.regional ?? []) : []).flatMap((closed) => {
      const ui = regionalRailUi(closed.currency);
      return ui && !rails.some((open) => open.currency === closed.currency)
        ? [
            {
              code: closed.currency,
              symbol: ui.symbol,
              flag: ui.flag,
              name: ui.name,
              hint: PAUSED_HINT,
              disabled: true,
            },
          ]
        : [];
    }),
  ];

  return {
    options,
    rail,
    band,
    // The channel itself, not the band — the admin can close deposits outright
    // while a gateway stays configured (getPaymentLimits, plan 135).
    closed: gateway && !rail && !limits.depositsEnabled,
    // The rail's own constant, or the list passed in: never a copy, so the
    // sheet's "disarm a retracted channel" effect sees a stable reference.
    methods: rail ? rail.ui.methods : methods,
    // The amount itself in RM, or the quoted RM credit for a regional payment
    // (floored to the cent, as the backend quotes it).
    credit: (paid) => (rail ? regionalCredit(paid, rail.rate.deposit) : paid),
  };
}

export type PayoutOffer = {
  /** The regional rail that pays this destination; undefined = RM. */
  rail: OpenRail | undefined;
  /** The RM band this payout is judged by, the account's own floor included. */
  band: { minRm: number; maxRm: number };
  /** The destination's own floor, when it sits above the rail's. */
  accountMin: number | null;
  /** No payout can go out to this destination right now. */
  closed: boolean;
  /** What a regional destination receives for `rmAmount`; null for RM. */
  payout: (rmAmount: number) => number | null;
  /** Which band `rmAmount` falls outside — the RM one is checked first. */
  outOfBand: (rmAmount: number) => 'rm' | 'regional' | null;
};

/**
 * What the withdraw form offers for a payout to `to`: the chosen account, or
 * the first one of the country on show (undefined = no saved account at all).
 * `accountFloorRm` is the selected payable account's own floor (Touch 'n Go:
 * RM 100).
 */
export function payoutOffer(
  limits: PaymentLimits,
  to: { currency?: string } | undefined,
  accountFloorRm?: number | null,
): PayoutOffer {
  // Regional payout rails (Singapore via A3Pay), open and priced. An account
  // in a regional currency is paid through its rail in that currency; every
  // other account through the active gateway in RM.
  const rails = openRails(limits.regional, 'withdrawal');
  const payCurrency = to?.currency;
  const toRegional = payCurrency !== undefined && payCurrency !== 'MYR';
  const rail = toRegional
    ? rails.find((option) => option.currency === payCurrency)
    : undefined;
  // The RM band THIS payout is judged by: the rail's own (its RM band
  // narrowed to what pays inside its S$ band) for a regional account, else
  // the active gateway's. At 3.2017, S$30 needs RM 96.05, not RM 50.
  const railBand = rail?.withdrawalRm ?? limits.withdrawal;
  // A destination can carry its own floor above the gateway's (Touch 'n Go:
  // RM 100 — smaller TNG payouts are refused by the gateway). The backend
  // enforces the same figure; this states it before the customer taps.
  const accountMin =
    accountFloorRm != null && accountFloorRm > railBand.minRm
      ? accountFloorRm
      : null;
  const band = { minRm: accountMin ?? railBand.minRm, maxRm: railBand.maxRm };
  // What a regional bank receives for this RM amount, at today's payout rate
  // (floored to the cent, exactly as the backend quotes and locks it).
  const payout = (rmAmount: number) =>
    rail ? regionalPayout(rmAmount, rail.rate.payout) : null;

  return {
    rail,
    band,
    accountMin,
    // The channel itself, not the band — the admin can close withdrawals
    // outright while a gateway stays configured (getPaymentLimits, plan 135).
    // Judged against the rail that would pay the country on show; with no
    // saved account at all, open if any rail is.
    closed: toRegional
      ? !rail
      : !limits.withdrawalsEnabled && (to !== undefined || rails.length === 0),
    payout,
    outOfBand: (rmAmount) => {
      if (rmAmount < band.minRm || rmAmount > band.maxRm) return 'rm';
      const paid = payout(rmAmount);
      if (!rail || paid === null) return null;
      const { min, max } = rail.withdrawal;
      return (min !== null && paid < min) || (max !== null && paid > max)
        ? 'regional'
        : null;
    },
  };
}
