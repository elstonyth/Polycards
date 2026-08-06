/**
 * The GlobePay365 deposit channels this merchant can actually open, and how
 * they are labelled to the customer.
 *
 * NOT the gateway's full method list. Their MYR set is FPX/DN/BQR/OB, but
 * `GetSupportedBanks` answers `400 Not found` for FPX and DN on merchant
 * Polycard — those two are known codes with nothing provisioned, so offering
 * them would be a button that always fails. Verified live 2026-08-06, the same
 * day support enabled deposits:
 *
 *   BQR → 200, 1 bank  (RHB, MYRHBB)  — DuitNow QR, paid from any e-wallet
 *   OB  → 200, 7 banks (Affin, Muamalat, CIMB, HLB, Maybank, Public, RHB)
 *   DN  → 400 Not found
 *   FPX → 400 Not found
 *
 * Re-check with that endpoint (a plain unsigned GET) before adding a code here;
 * the backend allow-list still gates the value, so an un-provisioned code fails
 * closed rather than reaching the gateway.
 *
 * PROVEN vs ASSUMED, because a 200 here does not mean a channel opens: during
 * the 2026-08-06 outage `OB` answered 200 with 7 banks while every OB deposit
 * was refused `PMT10006`. Only BQR has been seen to reach a cashier page since
 * support enabled deposits. OB is offered on their word plus the bank list, and
 * the first live OB top-up is what settles it — a bank/FPX-style selection page
 * is a pass, a DuitNow QR page means the backend ignored the method, and an
 * error means the channel is still shut.
 *
 * No `SourceClientBankCode` is sent for either. Assumed safe, not proven: the
 * field is documented mandatory for BMR only (see globepay-client.ts), so their
 * cashier is expected to collect the bank for OB. If that OB page turns up with
 * no bank list, this is the thing to fix — add a picker fed by
 * `GetSupportedBanks` and pass the code through `startGlobePayDeposit`.
 */
export const DEPOSIT_METHODS = [
  {
    code: 'BQR',
    label: 'QR / e-wallet',
    hint: 'DuitNow QR — TnG, GrabPay, ShopeePay, Boost',
  },
  {
    code: 'OB',
    label: 'Online banking',
    hint: 'Maybank, CIMB, Public, RHB, HLB, Affin, Muamalat',
  },
] as const;

export type DepositMethodCode = (typeof DEPOSIT_METHODS)[number]['code'];

/** Matches the backend's own default (GLOBEPAY_DEPOSIT_METHOD=BQR), so the
 *  pre-selected option is the channel that has been proven end to end. */
export const DEFAULT_DEPOSIT_METHOD: DepositMethodCode = 'BQR';

export function isDepositMethod(value: unknown): value is DepositMethodCode {
  return DEPOSIT_METHODS.some((method) => method.code === value);
}
