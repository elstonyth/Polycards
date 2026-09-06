/**
 * The deposit rails the top-up sheet offers, and how they are labelled to
 * the customer. The codes are the storefront's own rail names (BQR = QR /
 * e-wallet, OB = online banking); the backend's active gateway adapter maps
 * each onto its own channel (TGPay: BQR → hosted e-wallet, OB → hosted FPX)
 * and refuses a code it has no rail for as a definite error, so nothing here
 * can reach a checkout that cannot serve it.
 *
 * Retracting a rail without a rebuild is DEPOSIT_METHODS_ENABLED on the
 * storefront app (see enabledDepositMethods below).
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

/** Matches the backend's own default rail (BQR), so the
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
 * The channel used to be a backend RUN_TIME var an operator could flip in
 * ~4 minutes; now the storefront always sends a code. Without this, retracting an
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
