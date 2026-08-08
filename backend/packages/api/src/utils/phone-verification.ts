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
  // One Twilio Verify custom-template SID per purpose. Unset = Twilio's default
  // template, i.e. exactly today's behaviour, so this ships dark and the
  // operator turns it on per flow once the templates clear Twilio's approval.
  TWILIO_VERIFY_TEMPLATE_SID_SIGNUP?: string;
  TWILIO_VERIFY_TEMPLATE_SID_PHONE_CHANGE?: string;
  TWILIO_VERIFY_TEMPLATE_SID_PASSWORD_RESET?: string;
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

/** E.164: +, non-zero lead digit, 7–15 digits total. The storefront normalizes
 *  with libphonenumber before sending; this is the backend's shape re-check. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

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

/**
 * Refuses an empty key. `createHmac('sha256', '')` is legal in Node and returns
 * a MAC anyone can recompute, so an empty secret would make every phone proof
 * forgeable — which on this codebase means minting password-reset tokens.
 *
 * Unreachable today: all four call sites reject a falsy/non-string jwtSecret
 * first, and prod cannot boot without JWT_SECRET. The guard exists so a fifth
 * caller that forgets cannot silently downgrade the whole scheme; the
 * duplicated call-site checks stay, because they answer with a route-shaped
 * error instead of a 500.
 */
function assertSecret(secret: string): void {
  if (!secret) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Phone proof secret is not configured.',
    );
  }
}

export function signPhoneProof(
  secret: string,
  phone: string,
  purpose: PhoneOtpPurpose,
  nowMs: number = Date.now(),
): string {
  assertSecret(secret);
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
  assertSecret(secret);
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

const TEMPLATE_SID_ENV: Record<PhoneOtpPurpose, keyof PhoneVerificationEnv> = {
  signup: 'TWILIO_VERIFY_TEMPLATE_SID_SIGNUP',
  'phone-change': 'TWILIO_VERIFY_TEMPLATE_SID_PHONE_CHANGE',
  'password-reset': 'TWILIO_VERIFY_TEMPLATE_SID_PASSWORD_RESET',
};

/**
 * The Verify template to send this purpose's code under, or undefined for
 * Twilio's default.
 *
 * WHY per purpose: Twilio verifies on (phone, code) alone, and the default
 * template is identical for all three flows — so a code a victim reads back
 * under a "verify your number" pretext is exchangeable at /check for a
 * 'password-reset' proof, and that route returns a live reset token. The MAC'd
 * `purpose` stops a signup proof being REPLAYED at password-reset, but it is a
 * scope tag on the token, not evidence of what the human agreed to. Naming the
 * flow in the SMS is what lets the person reading it refuse.
 *
 * Not a complete fix: it makes the pretext visible, it does not make the
 * exchange impossible. Binding it outright needs a separate Verify Service per
 * purpose, so a code minted for one cannot check against another.
 */
export const otpTemplateSid = (
  env: PhoneVerificationEnv,
  purpose: PhoneOtpPurpose,
): string | undefined => env[TEMPLATE_SID_ENV[purpose]] || undefined;

/** Sends the OTP. Dev/test: logs the fixed dev code (the log is the SMS
 *  transport). Prod without Twilio: throws — enforcement on + unconfigured
 *  must brick LOUDLY, never silently skip verification. */
export async function sendPhoneOtp(
  env: PhoneVerificationEnv,
  logger: Logger,
  phone: string,
  purpose: PhoneOtpPurpose,
): Promise<void> {
  if (isDevOrTest(env)) {
    logger.warn(
      `[phone-otp] dev transport — ${purpose} code for ${phone} is ${devCode(env)}`,
    );
    return;
  }
  if (!isTwilioVerifyConfigured(env)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Phone verification is not configured.',
    );
  }
  const templateSid = otpTemplateSid(env, purpose);
  let res: Response;
  try {
    res = await fetch(`${twilioBase(env)}/Verifications`, {
      method: 'POST',
      headers: twilioHeaders(env),
      // TemplateSid is SMS-only (Twilio error 60408 rejects it on call/email);
      // this transport is sms-only, so it is always safe to include here.
      body: new URLSearchParams({
        To: phone,
        Channel: 'sms',
        ...(templateSid ? { TemplateSid: templateSid } : {}),
      }).toString(),
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
