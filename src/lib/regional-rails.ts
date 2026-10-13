import type { DepositMethodCode } from '@/lib/deposit-methods';
import { sgd, sgd0 } from '@/lib/format';
import type { RegionalRail } from '@/lib/payment-limits';

/**
 * How the storefront presents each regional rail the backend may open beside
 * the RM gateway (payment-limits.ts RegionalRail). One entry per currency: the
 * top-up sheet, the withdraw form and the startDeposit action all read it, so
 * a new rail (USDT next) is one entry here rather than a branch in each. A
 * rail the backend reports but this build has no entry for is never shown.
 */
export type RegionalRailUi = {
  /** Shown in the currency badge and in front of amounts ("S$"). */
  symbol: string;
  name: string;
  /** The picker row's subline, before the rate. */
  hint: string;
  presets: readonly number[];
  defaultAmount: string;
  /** The gateway channels, in the codes the backend allow-lists for it. */
  methods: readonly { code: DepositMethodCode; label: string; hint: string }[];
  /** Does the gateway match the transfer against the payer's account name?
   *  The sheet then asks for it, unless a saved account settles it. */
  needsPayerName: boolean;
  money: (n: number) => string;
  money0: (n: number) => string;
  /** Subject of the payout band message ("Singapore payouts"). */
  payoutNoun: string;
};

export const REGIONAL_RAILS: Readonly<Record<string, RegionalRailUi>> = {
  // Singapore (A3Pay): rungs sized for S$, and the two channels labelled the
  // way a Singapore payer knows them — the codes are the BQR / OB the backend
  // allow-lists for that gateway.
  SGD: {
    symbol: 'S$',
    name: 'Singapore Dollar',
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
