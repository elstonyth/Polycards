import type { FlagCountry } from '@/components/ui/country-flag';
import { sgd, sgd0, usdt, usdt0 } from '@/lib/format';
import type { RegionalRail } from '@/lib/payment-limits';

/**
 * How the storefront presents each regional rail the backend may open beside
 * the RM gateway (payment-limits.ts RegionalRail). One entry per currency: the
 * top-up sheet, the withdraw form and the startDeposit action all read it, so
 * a new rail (USDT next) is one entry here rather than a branch in each. A
 * rail the backend reports but this build has no entry for is never shown.
 */
export type RegionalRailUi = {
  /** Shown after the currency name and in front of amounts ("S$"). */
  symbol: string;
  /** The country flag on the picker row, so nobody pays in a currency
   *  their bank cannot send by mistake. */
  flag: FlagCountry;
  /** One unit, as the rate line reads it ("S$1 = RM 3.09"). */
  unit: string;
  name: string;
  /** The group its banks sit under in the bank pickers ("Singapore"). */
  country: string;
  /** The picker row's subline, before the rate. */
  hint: string;
  presets: readonly number[];
  defaultAmount: string;
  /** The gateway channels, in the codes the backend allow-lists for it. */
  methods: readonly { code: string; label: string; hint: string }[];
  /** Does the gateway match the transfer against the payer's account name?
   *  The sheet then asks for it, unless a saved account settles it. */
  needsPayerName: boolean;
  money: (n: number) => string;
  money0: (n: number) => string;
  /** Subject of the payout band message ("Singapore payouts"). */
  payoutNoun: string;
  /** Who the withdraw estimate says is paid ("Your bank"). */
  payee: string;
  /** What a payout lands in, for the withdraw page's copy. */
  paidTo: 'bank' | 'wallet';
  /** The top-up sheet's "pay the exact amount" note, in this rail's units. */
  exactAmountNote: string;
};

export const REGIONAL_RAILS: Readonly<Record<string, RegionalRailUi>> = {
  // Singapore (A3Pay): rungs sized for S$, and the two channels labelled the
  // way a Singapore payer knows them — the codes are the BQR / OB the backend
  // allow-lists for that gateway.
  SGD: {
    symbol: 'S$',
    flag: 'SG',
    unit: 'S$1',
    name: 'Singapore Dollar',
    country: 'Singapore',
    hint: 'PayNow QR · bank transfer',
    presets: [50, 100, 300, 1000],
    defaultAmount: '100',
    needsPayerName: true,
    methods: [
      {
        code: 'BQR',
        label: 'PayNow QR',
        hint: 'Scan with any Singapore bank app',
      },
      { code: 'OB', label: 'Bank transfer', hint: 'DBS, OCBC, UOB + more' },
    ],
    money: sgd,
    money0: sgd0,
    payoutNoun: 'Singapore payouts',
    payee: 'Your bank',
    paidTo: 'bank',
    exactAmountNote:
      'Transfer the exact amount the next page shows, cents included. It can be a few cents more than this (for example S$100.01). A rounded amount can’t be matched to your top-up.',
  },
  // USDT (GlobePay365): the chain it takes, in the code the backend
  // allow-lists for that gateway (UTRC). ERC20 (UERC) is withdrawn until
  // GlobePay365 opens it on production (backend gateway.ts says why).
  USDT: {
    symbol: 'USDT',
    // No country: Tether's own mark, so the picker still reads at a glance.
    flag: 'USDT',
    unit: '1 USDT',
    name: 'Tether',
    country: 'USDT',
    hint: 'TRC20',
    presets: [20, 50, 100, 300],
    defaultAmount: '50',
    // GlobePay365 does not match USDT transfers against a payer name.
    needsPayerName: false,
    methods: [
      {
        code: 'UTRC',
        label: 'USDT · TRC20',
        hint: 'Tron network — low fees',
      },
    ],
    money: usdt,
    money0: usdt0,
    payoutNoun: 'USDT payouts',
    payee: 'Your wallet',
    paidTo: 'wallet',
    exactAmountNote:
      'Send exactly the amount the next page shows. If your exchange takes a withdrawal fee, add it so that exact amount arrives: a payment that arrives short or over is not credited.',
  },
};

/** The presentation for a currency, or undefined for RM / an unknown rail. */
export function regionalRailUi(
  currency: string | null | undefined,
): RegionalRailUi | undefined {
  return currency && Object.hasOwn(REGIONAL_RAILS, currency)
    ? REGIONAL_RAILS[currency]
    : undefined;
}

export type OpenRail = RegionalRail & {
  rate: NonNullable<RegionalRail['rate']>;
  ui: RegionalRailUi;
};

/** The rails a customer can use right now for `kind`: open, priced, and
 *  known to this build. */
export function openRails(
  regional: readonly RegionalRail[] | undefined,
  kind: 'deposit' | 'withdrawal',
): OpenRail[] {
  return (regional ?? []).flatMap((rail) => {
    const ui = regionalRailUi(rail.currency);
    const open =
      kind === 'deposit' ? rail.depositsEnabled : rail.withdrawalsEnabled;
    return open && rail.rate && ui ? [{ ...rail, rate: rail.rate, ui }] : [];
  });
}

/** One country's share of a bank picker: its name, its flag (none for a
 *  currency this build has no rail for), and its banks or saved accounts. */
export type BankCountryGroup<T> = {
  country: string;
  flag?: FlagCountry;
  items: T[];
};

/** The country a bank pays into, by its currency: RM (or none, from an
 *  older backend) is Malaysia; a currency with no rail here is named as is. */
function bankCountry(
  currency: string | undefined,
): Omit<BankCountryGroup<never>, 'items'> {
  if (!currency || currency === 'MYR')
    return { country: 'Malaysia', flag: 'MY' };
  const ui = regionalRailUi(currency);
  return ui ? { country: ui.country, flag: ui.flag } : { country: currency };
}

/** Payout banks or saved accounts split by the country they pay into, for
 *  the pickers' country toggle: Malaysia first, then each regional rail's. A
 *  group with nothing in it is left out (the backend drops a closed rail's
 *  banks); a currency this build has no rail for keeps a group of its own
 *  rather than vanishing. */
export function bankCountryGroups<T extends { currency?: string }>(
  items: readonly T[],
): BankCountryGroup<T>[] {
  const groups = new Map<string, BankCountryGroup<T>>([
    ['Malaysia', { ...bankCountry(undefined), items: [] }],
  ]);
  for (const item of items) {
    const where = bankCountry(item.currency);
    const group = groups.get(where.country) ?? { ...where, items: [] };
    groups.set(where.country, { ...group, items: [...group.items, item] });
  }
  return [...groups.values()].filter((group) => group.items.length > 0);
}
