import { randomUUID } from 'node:crypto';
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

const serialize = ({ purpose, sid }: PendingCode): string =>
  JSON.stringify({ purpose, ...(sid ? { sid } : {}) });

// A start never ends a pending code of a flow that outranks its own: a
// password reset is the account holder's, a phone change a signed-in
// player's, and a signup start needs no sign-in at all.
const RANK: Record<PhoneOtpPurpose, number> = {
  signup: 0,
  'phone-change': 1,
  'password-reset': 2,
};
export const outranks = (pending: PhoneOtpPurpose, purpose: PhoneOtpPurpose) =>
  RANK[pending] > RANK[purpose];

// A start sends only within SEND_BY_MS of taking its hold, and a send gives
// up after Twilio's 10 s, so the hold outlives every send: no other start,
// and no record write, can land between a start's check and its send.
export const START_HOLD_MS = 120_000;
export const SEND_BY_MS = 60_000;

export type StartHold = {
  /** Still this start's, and young enough to send: one that stalled must not. */
  held(): Promise<boolean>;
  /** Records the code's flow and verification, only while still held. */
  note(purpose: PhoneOtpPurpose, sid?: string): Promise<boolean>;
  release(): Promise<void>;
};

/** One start at a time per number, across replicas: the pending read, the
 *  cancel, the send and the record must not interleave with another start.
 *  The hold, or null when another start holds the number. */
export async function holdStart(phone: string): Promise<StartHold | null> {
  const claims = warmSignupProofClaims();
  const key = `otp-start:${phone}`;
  const owner = randomUUID();
  if (!(await claims.claim(key, START_HOLD_MS, owner))) return null;
  const takenAt = Date.now();
  return {
    held: async () =>
      Date.now() - takenAt < SEND_BY_MS && (await claims.get(key)) === owner,
    note: (purpose, sid) =>
      claims.putIfHeld(
        key,
        owner,
        recordKey(phone),
        serialize({ purpose, sid }),
        OTP_PURPOSE_TTL_MS,
      ),
    release: () => claims.releaseIf(key, owner).catch(() => undefined),
  };
}

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
    serialize({ purpose, sid }),
    OTP_PURPOSE_TTL_MS,
  );
}

/** No flow accepts the number's pending code until a new start: for a code
 *  whose cancel could not be confirmed. */
export async function dropPendingCode(phone: string): Promise<void> {
  await warmSignupProofClaims().release(recordKey(phone));
}

/** After a code is used: the next flow starts clean. Only the record this
 *  check read: one a newer start wrote meanwhile stays. */
export async function forgetPurpose(
  phone: string,
  read: PendingCode,
): Promise<void> {
  await warmSignupProofClaims().releaseIf(recordKey(phone), serialize(read));
}
