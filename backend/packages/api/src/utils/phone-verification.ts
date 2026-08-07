import { createHmac, timingSafeEqual } from 'crypto';
import { MedusaError } from '@medusajs/framework/utils';

// SMS OTP for the three phone flows (signup / phone-change / password-reset).
// Twilio Verify holds the codes — nothing OTP-shaped is ever persisted here.
// A passed check mints a short-lived HMAC "proof token" that the write gates
// (see api/utils/phone-verification-guard.ts and the phone-verification
// routes) accept as evidence of phone possession. Stateless by design: no
// table, no migration; replay inside the 10m TTL only lets the same PROVEN
// phone be used again, which every consumer tolerates.
//
// Mirrors modules/resend/options.ts: one env predicate shared by everything
// that gates on configuration, and dev/test NEVER touches the live transport
// (the logged dev code IS the local SMS transport, checked BEFORE Twilio
// config so real credentials in a dev .env can't send SMS from a dev box).

export type PhoneVerificationEnv = {
  NODE_ENV?: string;
  PHONE_VERIFICATION_REQUIRED?: string;
  PHONE_GATE_REQUIRED?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  PHONE_OTP_DEV_CODE?: string;
  ALLOWED_SMS_COUNTRIES?: string;
};

type Logger = { warn: (msg: string) => void };

export const isPhoneVerificationRequired = (env: PhoneVerificationEnv): boolean =>
  env.PHONE_VERIFICATION_REQUIRED === 'true';

/**
 * The MONEY/GOODS gate (requirePhoneVerified) — separate from the signup and
 * phone-change gates above, because they are different risks with different
 * blast radii and must be rollback-able independently.
 *
 * PHONE_VERIFICATION_REQUIRED closes a door on WRITING a phone: a handful of
 * signups per day, and turning it off costs nothing already banked. This one
 * blocks topping up and shipping for every account that has not verified —
 * currently the large majority. If the two shared a switch, the documented
 * rollback lever ("flip PHONE_VERIFICATION_REQUIRED off", CONTEXT.md) could not
 * reopen the money path without also reopening unproven phone writes.
 *
 * Unset (or empty) means "follow PHONE_VERIFICATION_REQUIRED", so the deploy
 * needs no new configuration to behave as intended — the extra variable exists
 * to be set to 'false' in a hurry.
 */
export const isPhoneGateRequired = (env: PhoneVerificationEnv): boolean => {
  const own = env.PHONE_GATE_REQUIRED;
  if (own === undefined || own === '') return isPhoneVerificationRequired(env);
  return own === 'true';
};

export const isTwilioVerifyConfigured = (env: PhoneVerificationEnv): boolean =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);

export type PhoneGateState = {
  phoneVerificationRequired: boolean;
  phoneGateRequired: boolean;
  twilioConfigured: boolean;
  /** Variables an operator set to something that resolves to `false`. */
  warnings: string[];
};

// Only these two are boolean-parsed, and only they can be silently misread.
const BOOLEAN_GATE_VARS = [
  'PHONE_VERIFICATION_REQUIRED',
  'PHONE_GATE_REQUIRED',
] as const;

/**
 * The RESOLVED gate state, for the boot log in medusa-config.ts. Pure (env in,
 * object out) — it changes no semantics and MUST NOT throw: a fail-open deploy
 * is a legitimate configuration, so this is observability, not a guard
 * (contrast assertMockTopupSafe, which refuses to boot by design).
 *
 * Why it exists: the parse is strictly `=== 'true'`, so unset, empty, 'True',
 * '1' or a misspelled key all resolve to false, and PHONE_GATE_REQUIRED
 * FOLLOWS PHONE_VERIFICATION_REQUIRED when unset — one wrong value opens the
 * money gates as well as the write gates. That fail-open default is a recorded
 * decision (CONTEXT.md's rollback lever, exercised on 2026-08-07), but nothing
 * logged or asserted the resolved state, and the flag lives in two .do specs
 * plus a Dockerfile ARG. Now the state a deploy actually booted with is in the
 * log.
 *
 * `warnings` fires only when a raw value is neither 'true' nor 'false' — an
 * operator meant something by it and got `false`. An explicit 'false' is not a
 * typo (it is the in-a-hurry lever) and never warns. The raw value is
 * deliberately NOT carried: these two are boolean-shaped, but a reporter that
 * echoes env values is one copy-paste from printing a credential into a public
 * deploy log.
 */
export const resolvePhoneGateState = (
  env: PhoneVerificationEnv,
): PhoneGateState => ({
  phoneVerificationRequired: isPhoneVerificationRequired(env),
  phoneGateRequired: isPhoneGateRequired(env),
  twilioConfigured: isTwilioVerifyConfigured(env),
  warnings: BOOLEAN_GATE_VARS.filter((name) => {
    const raw = env[name];
    return raw !== undefined && raw !== '' && raw !== 'true' && raw !== 'false';
  }).map((name) => `${name} is neither 'true' nor 'false' — read as false`),
});

/** E.164: +, non-zero lead digit, 7–15 digits total. The storefront normalizes
 *  with libphonenumber before sending; this is the backend's shape re-check. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Destinations this business serves. POST /store/phone-verification/start is
 * UNAUTHENTICATED and bills a real SMS per call; the per-phone limiter bounds
 * one number, so a pumping run using fresh numbers is bounded only by the
 * sitewide IP tier — thousands of attacker-chosen destinations a day. This is
 * the coarse geo-lock the repo can enforce; Twilio's own geo permissions are
 * the other half (console state, not code).
 *
 * Default is MY alone: CONTEXT.md records Malaysia (+60) as the one country
 * confirmed enabled in Twilio's SMS geo permissions, and DEFAULT_PHONE_COUNTRY
 * is 'MY'. Widen via ALLOWED_SMS_COUNTRIES.
 *
 * PAIRED with the storefront picker (ALLOWED_PHONE_COUNTRIES in
 * src/lib/profile-validation.ts, rendered by src/components/PhoneField.tsx).
 * Widen BOTH or neither: narrowing only here makes the UI offer a country
 * whose code silently never arrives; narrowing only there reopens the toll
 * fraud. E164_RE stays permissive — that is a shape check, this is a business
 * check, and they are deliberately separate.
 */
export const DEFAULT_ALLOWED_SMS_COUNTRIES = ['MY'] as const;

// ISO 3166-1 alpha-2 → E.164 calling-code prefix.
//
// ponytail: a prefix match, not a phone-number parser. The allowlist is coarse
// by design and the backend does not depend on libphonenumber-js (only the
// storefront does) — pulling a parser in for a handful of string comparisons
// is not worth it.
//
// DO NOT add a `+1` or `+7` row on that reasoning. A prefix is only "coarse but
// safe" where the calling code maps to ONE country. `US: '+1'` would admit the
// whole NANP — including +1-809, +1-876 and the other classic revenue-share
// destinations — so a one-line "widening" would reopen precisely the toll fraud
// this table exists to stop. Those calling codes need a real parser or an
// area-code deny list, not a prefix.
//
// An ISO code with NO row here resolves to nothing. See
// unresolvableSmsCountries below: the route logs those, because otherwise the
// misconfiguration is invisible.
const SMS_DIAL_PREFIX: Record<string, string> = {
  MY: '+60',
  GB: '+44',
};

/**
 * The configured ISO codes, or the default set when nothing usable is set.
 *
 * Env is read PER CALL, not at module top, so one booted app can be driven
 * through both states (plan 066's convention).
 *
 * An empty or whitespace-only value falls back to the default set. It must
 * never be read as "allow everything" (that is the whole exposure), and
 * equally never as "allow nothing" — a stray blank in the DO spec would then
 * brick every signup.
 */
const allowedSmsCountries = (env: PhoneVerificationEnv): readonly string[] => {
  const configured = (env.ALLOWED_SMS_COUNTRIES ?? '')
    .split(',')
    .map((iso) => iso.trim().toUpperCase())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_SMS_COUNTRIES;
};

/**
 * Configured ISO codes that resolve to no dialling-code prefix, i.e. that do
 * nothing at all.
 *
 * This is the loud half of the trap above. `ALLOWED_SMS_COUNTRIES=SG` is
 * non-empty, so the default is NOT substituted, and SG matches nothing — which
 * stops EVERY signup and phone-change OTP, `+60` included, with no error
 * anywhere. That failure is indistinguishable from a Twilio outage; CONTEXT.md
 * records a same-shaped incident (21608) that cost a day to diagnose. The
 * caller logs whatever this returns.
 */
export const unresolvableSmsCountries = (
  env: PhoneVerificationEnv,
): string[] =>
  allowedSmsCountries(env).filter((iso) => SMS_DIAL_PREFIX[iso] === undefined);

/** True iff `phone` (already E.164-shaped) is in a served destination. */
export const isAllowedSmsDestination = (
  env: PhoneVerificationEnv,
  phone: string,
): boolean =>
  allowedSmsCountries(env).some((iso) => {
    const prefix = SMS_DIAL_PREFIX[iso];
    return prefix !== undefined && phone.startsWith(prefix);
  });

export const PHONE_OTP_PURPOSES = ['signup', 'phone-change', 'password-reset'] as const;
export type PhoneOtpPurpose = (typeof PHONE_OTP_PURPOSES)[number];
export const isPhoneOtpPurpose = (v: unknown): v is PhoneOtpPurpose =>
  typeof v === 'string' && (PHONE_OTP_PURPOSES as readonly string[]).includes(v);

/** ponytail: 10m fixed TTL, no config knob — add one only if support tickets ask. */
const PROOF_TTL_MS = 10 * 60_000;

// Twilio call budget — a hung request must fail into the existing retryable
// error, not hold the request (and this worker) open indefinitely.
const TWILIO_TIMEOUT_MS = 10_000;

// Domain-separates this HMAC from anything else ever signed with the same
// jwtSecret — notably the app's own HS256 JWTs (login/register/reset tokens
// all share this secret). Prepending a fixed, format-specific string to the
// HMAC input means a signature computed for one format can never verify
// against the other, even though the underlying key is identical.
const PROOF_HMAC_DOMAIN = 'phone-proof.v1';

type ProofPayload = { phone: string; purpose: PhoneOtpPurpose; exp: number };

export function signPhoneProof(
  secret: string,
  phone: string,
  purpose: PhoneOtpPurpose,
  nowMs: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ phone, purpose, exp: nowMs + PROOF_TTL_MS } satisfies ProofPayload),
  ).toString('base64url');
  const sig = createHmac('sha256', secret)
    .update(`${PROOF_HMAC_DOMAIN}.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPhoneProof(
  secret: string,
  token: string,
  purpose: PhoneOtpPurpose,
  nowMs: number = Date.now(),
): { phone: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret)
    .update(`${PROOF_HMAC_DOMAIN}.${payload}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: ProofPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ProofPayload;
  } catch {
    return null;
  }
  if (parsed.purpose !== purpose) return null;
  if (typeof parsed.exp !== 'number' || parsed.exp <= nowMs) return null;
  if (typeof parsed.phone !== 'string' || !E164_RE.test(parsed.phone)) return null;
  return { phone: parsed.phone };
}

const isDevOrTest = (env: PhoneVerificationEnv): boolean => {
  const nodeEnv = env.NODE_ENV ?? process.env.NODE_ENV;
  return nodeEnv === 'development' || nodeEnv === 'test';
};

const devCode = (env: PhoneVerificationEnv): string => env.PHONE_OTP_DEV_CODE || '000000';

const twilioBase = (env: PhoneVerificationEnv): string =>
  `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}`;

const twilioHeaders = (env: PhoneVerificationEnv): Record<string, string> => ({
  Authorization:
    'Basic ' +
    Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
  'Content-Type': 'application/x-www-form-urlencoded',
});

// Twilio answers a refused send with a numeric error code, and that code is
// the only thing that says WHY: an unfunded/trial account, a geo-permission
// block and a Fraud Guard hit all arrive as the same bare 403. Log the code
// alongside the status so the next outage is diagnosable from the app logs
// instead of a console session. Only the code — the rest of the body echoes
// To=, i.e. the phone number.
const twilioErrorCode = async (res: Response): Promise<number | null> => {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === 'number' ? body.code : null;
  } catch {
    return null;
  }
};

/** Sends the OTP. Dev/test: logs the fixed dev code (the log is the SMS
 *  transport). Prod without Twilio: throws — enforcement on + unconfigured
 *  must brick LOUDLY, never silently skip verification. */
export async function sendPhoneOtp(
  env: PhoneVerificationEnv,
  logger: Logger,
  phone: string,
): Promise<void> {
  if (isDevOrTest(env)) {
    logger.warn(`[phone-otp] dev transport — code for ${phone} is ${devCode(env)}`);
    return;
  }
  if (!isTwilioVerifyConfigured(env)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Phone verification is not configured.',
    );
  }
  let res: Response;
  try {
    res = await fetch(`${twilioBase(env)}/Verifications`, {
      method: 'POST',
      headers: twilioHeaders(env),
      body: new URLSearchParams({ To: phone, Channel: 'sms' }).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
  } catch {
    // Timeout (AbortError) or any other network failure — same retryable
    // message as a bad Twilio response below; never let this escape as an
    // unhandled rejection / raw 500. Status-free warn (no status to report,
    // and never the phone or a Twilio error body).
    logger.warn('[phone-otp] twilio send request failed (network/timeout)');
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not send the verification code. Try again shortly.',
    );
  }
  if (!res.ok) {
    // Twilio 429s (per-number caps, Fraud Guard) land here too — surface a
    // retryable message, log the status and the error code only (never the
    // rest of the body: it echoes To=).
    logger.warn(
      `[phone-otp] twilio send failed with ${res.status} (code ${(await twilioErrorCode(res)) ?? 'none'})`,
    );
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not send the verification code. Try again shortly.',
    );
  }
}

/** True iff the code is approved for this phone. Never throws on a wrong
 *  code — only on transport-level failure. */
export async function checkPhoneOtpCode(
  env: PhoneVerificationEnv,
  logger: Logger,
  phone: string,
  code: string,
): Promise<boolean> {
  if (isDevOrTest(env)) return code === devCode(env);
  if (!isTwilioVerifyConfigured(env)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Phone verification is not configured.',
    );
  }
  let res: Response;
  try {
    res = await fetch(`${twilioBase(env)}/VerificationCheck`, {
      method: 'POST',
      headers: twilioHeaders(env),
      body: new URLSearchParams({ To: phone, Code: code }).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
  } catch {
    // Same reasoning as sendPhoneOtp's catch above: a timeout must map to
    // the existing friendly error, never escape raw.
    logger.warn('[phone-otp] twilio check request failed (network/timeout)');
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not verify the code. Try again shortly.',
    );
  }
  // Twilio 404s a check whose verification already expired/was consumed —
  // that's a plain "wrong/expired code" to us, not a transport failure.
  if (res.status === 404) return false;
  if (!res.ok) {
    logger.warn(
      `[phone-otp] twilio check failed with ${res.status} (code ${(await twilioErrorCode(res)) ?? 'none'})`,
    );
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not verify the code. Try again shortly.',
    );
  }
  const body = (await res.json()) as { status?: string };
  return body.status === 'approved';
}
