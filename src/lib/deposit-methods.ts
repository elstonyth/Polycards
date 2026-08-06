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
 * Re-check with that endpoint (a plain unsigned GET) before adding a code here,
 * because THIS LIST IS THE ONLY THING KEEPING DN/FPX OUT. The backend's
 * allow-list is the gateway's whole MYR set — `GLOBEPAY_MYR_METHODS` in
 * packs/globepay-deposit.ts is `['FPX','DN','BQR','OB']`, so both un-provisioned
 * codes pass validation there and reach the cashier, where they fail. Nothing
 * downstream catches a code added here by mistake.
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
    // Deliberately not a wallet roll-call. Their cashier page advertises TnG /
    // GrabPay / ShopeePay / Boost, but what we have measured is one bank
    // (MYRHBB) behind a DuitNow QR — naming wallets we never tested is a
    // support ticket on the one screen where being wrong costs money.
    hint: 'Scan with any DuitNow e-wallet',
  },
  {
    code: 'OB',
    label: 'Online banking',
    hint: 'Maybank, CIMB, Public, RHB + more',
  },
] as const;

export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export type DepositMethodCode = DepositMethod['code'];

/** Matches the backend's own default (GLOBEPAY_DEPOSIT_METHOD=BQR), so the
 *  pre-selected option is the channel that has been proven end to end. */
export const DEFAULT_DEPOSIT_METHOD: DepositMethodCode = 'BQR';

export function isDepositMethod(value: unknown): value is DepositMethodCode {
  return DEPOSIT_METHODS.some((method) => method.code === value);
}

/**
 * The runtime retract switch, and the reason this takes `raw` instead of
 * reading `process.env` itself: it is called from a server component and from a
 * server action, and a module a CLIENT component also imports must not depend
 * on server env being there.
 *
 * It exists because the picker took away the only per-channel lever there was.
 * The channel used to be `GLOBEPAY_DEPOSIT_METHOD`, a backend RUN_TIME var an
 * operator could flip in ~4 minutes; now the storefront always sends a code, so
 * that var can never fire for customer traffic. Without this, retracting an
 * OB that turns out dead would mean a storefront image REBUILD (the provider
 * flag is a NEXT_PUBLIC baked in at build time), and the only runtime lever
 * left would be GLOBEPAY_ENABLED, which kills every top-up including the QR
 * channel that works.
 *
 * `DEPOSIT_METHODS_ENABLED=BQR` on the storefront app retracts online banking
 * at the next restart. Unset, empty, or naming nothing we recognise means all
 * of them: a typo must not silently leave customers with no way to pay, and
 * killing top-ups outright is GLOBEPAY_ENABLED's job, not this one's.
 */
export function enabledDepositMethods(
  raw: string | undefined,
): readonly DepositMethod[] {
  const wanted = (raw ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  if (wanted.length === 0) return DEPOSIT_METHODS;
  const allowed = DEPOSIT_METHODS.filter((method) =>
    wanted.includes(method.code),
  );
  return allowed.length > 0 ? allowed : DEPOSIT_METHODS;
}
