import { randomInt } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import type PacksModuleService from '../modules/packs/service';
import { findCustomerByReferralCode } from './customer-by-handle';

// The public referral code — the short identity a recruit arrives with via
// /r/<code> or pastes into the signup form. Lives in customer
// metadata.referral_code beside metadata.handle and is assigned lazily the
// first time the customer opens their referral panel (ensureReferralCode).
//
// Random, not derived from the id like the handle: the handle is printed on
// every public profile, and a code anyone could compute from it would let a
// stranger claim a downline they never recruited. 8 symbols from a 32-symbol
// alphabet (no 0/O/1/I look-alikes) is 40 bits — unguessable at the bind
// route's rate limit, short enough to read out loud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LEN = 8;

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

const MAX_ATTEMPTS = 5;

/**
 * The customer's referral code, assigned on first call. Idempotent: an
 * existing metadata.referral_code is returned untouched. The write goes
 * through the `metadata:<customer>` advisory lock like every other metadata
 * writer (see the ensure-profile-handle step) and re-checks inside the lock,
 * so two concurrent first requests converge on one code.
 *
 * ponytail: uniqueness is a pre-check on the same unindexed JSONB scan the
 * handle lookup uses, not a constraint — move both to a keyed table if the
 * customer count ever makes that scan slow.
 */
export async function ensureReferralCode(
  customers: ICustomerModuleService,
  packs: PacksModuleService,
  customerId: string,
): Promise<string> {
  const customer = await customers.retrieveCustomer(customerId, {
    select: ['id', 'metadata'],
  });
  const existing = (customer.metadata ?? {}).referral_code;
  if (typeof existing === 'string' && REFERRAL_CODE_RE.test(existing)) {
    return existing;
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generateReferralCode();
    if (await findCustomerByReferralCode(customers, candidate)) continue;
    const metadata = await packs.mutateCustomerMetadata({
      customerId,
      mutate: (locked) =>
        typeof locked.referral_code === 'string'
          ? null // a concurrent first request won — keep theirs
          : { ...locked, referral_code: candidate },
    });
    const code = metadata.referral_code;
    if (typeof code === 'string') return code;
  }
  // Five random collisions in a 40-bit space — practically unreachable.
  throw new MedusaError(
    MedusaError.Types.CONFLICT,
    'Could not assign a referral code',
  );
}
