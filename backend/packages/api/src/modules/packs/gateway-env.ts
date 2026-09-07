// The payment-gateway switches and knobs, read by their gateway-neutral names
// with the pre-2026-09-07 GLOBEPAY_* names as a fallback: production's spec
// still carries the old names and must keep working until the operator moves
// it. ONE place knows both spellings — every reader goes through here, and
// the boot-time warning below names each legacy variable still set.

const LEGACY_NAME = {
  GATEWAY_ENABLED: 'GLOBEPAY_ENABLED',
  GATEWAY_WITHDRAWALS_ENABLED: 'GLOBEPAY_WITHDRAWALS_ENABLED',
  GATEWAY_WD_APPROVAL_ABOVE_RM: 'GLOBEPAY_WD_APPROVAL_ABOVE_RM',
  GATEWAY_WD_DAILY_MAX_RM: 'GLOBEPAY_WD_DAILY_MAX_RM',
  GATEWAY_AMBIGUOUS_GIVEUP_MS: 'GLOBEPAY_AMBIGUOUS_GIVEUP_MS',
  PAYMENT_RETURN_URL: 'GLOBEPAY_RETURN_URL',
} as const;

export type GatewayEnvName = keyof typeof LEGACY_NAME;

const CURRENT_NAMES = Object.keys(LEGACY_NAME) as GatewayEnvName[];

/** The value under the current name, else under its legacy name. */
export function gatewayEnv(
  name: GatewayEnvName,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string | undefined {
  return env[name] ?? env[LEGACY_NAME[name]];
}

/**
 * The NAME that is set (current wins), for readers that take a name rather
 * than a value — nonNegativeIntFromEnv reads process.env itself and logs the
 * name it read.
 */
export function gatewayEnvName(
  name: GatewayEnvName,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string {
  return env[name] !== undefined ? name : LEGACY_NAME[name];
}

/** The legacy spelling of one name — for a spec that must clear BOTH. */
export function legacyGatewayEnvName(name: GatewayEnvName): string {
  return LEGACY_NAME[name];
}

/** The legacy names still set in this environment, oldest spelling first. */
export function legacyGatewayEnvNames(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string[] {
  return CURRENT_NAMES.map((name) => LEGACY_NAME[name]).filter(
    (legacy) => env[legacy] !== undefined,
  );
}

/**
 * One boot-time warning naming every legacy variable still set, or nothing.
 * Console by default: this runs from medusa-config.ts, before the container
 * (and its logger) exists. Returns the names so a spec can assert them.
 */
export function warnLegacyGatewayEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env,
  warn: (message: string) => void = console.warn,
): string[] {
  const legacy = legacyGatewayEnvNames(env);
  if (legacy.length > 0) {
    const pairs = legacy.map((old) => {
      const current = CURRENT_NAMES.find((name) => LEGACY_NAME[name] === old);
      return `${old} (read as ${current})`;
    });
    warn(
      `[payments] legacy env names still set: ${pairs.join(', ')} — rename them in the deploy spec; the fallback will be removed.`,
    );
  }
  return legacy;
}
