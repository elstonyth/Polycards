/** Storefront mirror of the backend's PHONE_VERIFICATION_REQUIRED flag.
 * NEXT_PUBLIC_* is inlined at BUILD time — set it in the DO build env, and
 * keep it in lockstep with the backend flag. Drift is UX-only: the backend
 * gate is authoritative (a skipped OTP step surfaces as a clear 400; an
 * extra OTP step is harmless). */
export const PHONE_VERIFICATION_REQUIRED =
  process.env.NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED === 'true';

export type PhoneOtpPurpose = 'signup' | 'phone-change' | 'password-reset';

/** Mirror of the backend's PHONE_OTP_CHANNELS. 'call' = Twilio reads the code
 *  aloud — the fallback for numbers whose SMS is "Delivered" but never read. */
export type PhoneOtpChannel = 'sms' | 'call';
