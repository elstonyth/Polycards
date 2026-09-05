import { randomInt } from 'node:crypto';
import type { CustomerDTO, ICustomerModuleService } from '@medusajs/types';
import type PacksModuleService from '../modules/packs/service';
import { findCustomerByReferralCode } from './customer-by-metadata';

// The public referral code — the short identity a recruit arrives with via
// /r/<code> or pastes into the signup form. Lives in customer
// metadata.referral_code — now the only thing in that blob besides the avatar
// keys, since the profile handle became the display name itself — and is
// assigned lazily the first time the customer opens their referral panel
// (PacksModuleService.assignReferralCode, which serializes allocation so no
// two customers ever share a code).
//
// Random, not derived from the id or the name: the display name is printed on
// every public profile, and a code anyone could compute from it would let a
// stranger claim a downline they never recruited. 8 symbols from a 32-symbol
// alphabet (no 0/O/1/I look-alikes) is 40 bits — unguessable at the bind
// route's rate limit, short enough to read out loud. (ADR 0008.)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LEN = 8;

/** Accepted INPUT shape (after normalizeReferralCode). Deliberately looser
 *  than the alphabet: a mistyped 0-for-O still reaches the lookup and fails
 *  there as "not found" instead of a confusing shape error. */
export const REFERRAL_CODE_RE = /^[A-Z0-9]{8}$/;

export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LEN; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** Uppercases and strips spaces/dashes (people paste "f42b-0700"); null when
 *  what remains is not a code. */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

/**
 * The referrer a code may bind to, or null. A disabled account is hidden
 * here — the ONE place — so the public lookup (GET /store/referral/codes/:code)
 * and the bind (POST /store/referral/bind) can never disagree about a code.
 * (bindReferral rechecks the disable inside its own transaction; this is the
 * request-time answer, that is the write-time one.)
 */
export async function findBindableReferrer(
  customers: ICustomerModuleService,
  packs: PacksModuleService,
  code: string,
): Promise<CustomerDTO | null> {
  const referrer = await findCustomerByReferralCode(customers, code);
  if (!referrer || (await packs.isAccountDisabled(referrer.id))) return null;
  return referrer;
}
