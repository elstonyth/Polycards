import {
  isPhoneOtpPurpose,
  type PhoneOtpPurpose,
} from '../../utils/phone-verification';
import { warmSignupProofClaims } from './rate-limit';

// Twilio checks (phone, code) alone, so a code sent for one flow would pass
// /check for another. Each number's pending code is recorded with the flow it
// was sent for and its Twilio verification. A start for another flow cancels that
// verification first (Twilio would otherwise resend the same code), so the
// record can follow the newest flow and nobody is locked out of theirs.

// Twilio Verify's default code lifetime.
export const OTP_PURPOSE_TTL_MS = 10 * 60_000;
const recordKey = (phone: string) => `otp-purpose:${phone}`;

export type PendingCode = { purpose: PhoneOtpPurpose; sid?: string };

/** The flow (and Twilio verification) of the number's pending code, or null. */
export async function pendingCode(phone: string): Promise<PendingCode | null> {
  const raw = await warmSignupProofClaims().get(recordKey(phone));
  if (!raw) return null;
  try {
    const { purpose, sid } = JSON.parse(raw) as {
      purpose?: unknown;
      sid?: unknown;
    };
    if (!isPhoneOtpPurpose(purpose)) return null;
    return typeof sid === 'string' ? { purpose, sid } : { purpose };
  } catch {
    return null;
  }
}

/** After a code is sent: records its flow and verification. */
export async function notePurposeSent(
  phone: string,
  purpose: PhoneOtpPurpose,
  sid?: string,
): Promise<void> {
  await warmSignupProofClaims().put(
    recordKey(phone),
    JSON.stringify({ purpose, ...(sid ? { sid } : {}) }),
    OTP_PURPOSE_TTL_MS,
  );
}

/** After a code is used: the next flow starts clean. */
export async function forgetPurpose(phone: string): Promise<void> {
  await warmSignupProofClaims().release(recordKey(phone));
}
