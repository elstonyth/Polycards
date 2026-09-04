'use server';

/**
 * Customer profile server action. Called from the client settings form.
 *
 * Runs server-side so the customer JWT stays in the httpOnly cookie and the
 * Store-API call carries an explicit Bearer (see `updateCustomerProfile`). The
 * action validates at the boundary — a server action is a public endpoint — and
 * maps backend errors to friendly copy so raw errors never reach the UI.
 *
 * `email` is intentionally not editable: Medusa's `StoreUpdateCustomer` omits it.
 */
import type { HttpTypes } from '@medusajs/types';
import { logger } from '@/lib/logger';
import { updateCustomerProfile } from '@/lib/data/customer';
import { friendlyError, httpStatus, type ErrorRule } from '@/lib/errors';
import {
  NAME_MAX,
  normalizePhone,
  usernameError,
} from '@/lib/profile-validation';
import { PHONE_VERIFICATION_REQUIRED } from '@/lib/phone-verification';

export type ProfileCustomer = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
};

export type ProfileResult =
  { ok: true; customer: ProfileCustomer } | { ok: false; error: string };

const toProfileCustomer = (c: HttpTypes.StoreCustomer): ProfileCustomer => ({
  id: c.id,
  email: c.email,
  first_name: c.first_name ?? null,
  last_name: c.last_name ?? null,
  phone: c.phone ?? null,
});

// A cleared field is sent as `null` (clears it); an absent field stays absent.
const clean = (v: string | undefined): string | null | undefined => {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed.slice(0, NAME_MAX);
};

const USERNAME_TAKEN = 'That username is taken — please pick another.';

const PROFILE_RULES: ErrorRule[] = [
  [
    /not authenticated|unauthorized|401/i,
    'Your session has expired. Please log in again.',
  ],
  // The backend's username guard answers a taken name with this sentence.
  [/display name is already taken|username is taken/i, USERNAME_TAKEN],
  // …and the SAME outcome arrives as a raw Postgres error when two renames
  // race past that guard and the unique index refuses the loser. Without this
  // rule that user sees a database string; the guard cannot close the window
  // itself, so the copy has to cover both doors.
  [
    /IDX_customer_first_name_lower_unique|duplicate key value|unique constraint/i,
    USERNAME_TAKEN,
  ],
];

export async function updateProfile(input: {
  first_name?: string;
  last_name?: string;
  phone?: string;
}): Promise<ProfileResult> {
  // Reject (don't silently truncate) an over-long name — the form caps input
  // at NAME_MAX too, so this only fires for API callers bypassing the UI.
  for (const name of [input.first_name, input.last_name]) {
    if (name !== undefined && name.trim().length > NAME_MAX) {
      return {
        ok: false,
        error: `Names must be ${NAME_MAX} characters or fewer.`,
      };
    }
  }
  // The display name is the public profile URL, so its shape is a hard rule,
  // not a preference. Checked here as well as in the backend's username guard
  // because a server action is a public endpoint in its own right.
  if (input.first_name !== undefined) {
    const bad = usernameError(input.first_name);
    if (bad) return { ok: false, error: bad };
  }
  const body: HttpTypes.StoreUpdateCustomer = {
    first_name: clean(input.first_name),
    last_name: clean(input.last_name),
  };

  // Under phone-verification enforcement, phone writes go through
  // `changePhone` (proven via OTP) instead — the backend gate (Task 3) 400s
  // the WHOLE save if a string `phone` rides along here, so omit the key
  // entirely rather than validate/send it. Names still save normally.
  if (!PHONE_VERIFICATION_REQUIRED) {
    // Phone stays optional here (existing accounts may not have one yet), but
    // a non-empty value must be a valid number — stored normalized to E.164.
    let phone = clean(input.phone);
    if (typeof phone === 'string') {
      const normalized = normalizePhone(phone);
      if (!normalized) {
        return {
          ok: false,
          error: 'Please enter a valid phone number for the selected country.',
        };
      }
      phone = normalized;
    }
    body.phone = phone;
  }

  try {
    const customer = await updateCustomerProfile(body);
    return { ok: true, customer: toProfileCustomer(customer) };
  } catch (error) {
    logger.error('[profile] update failed:', error);
    // Message rules first, status second — same order as signup(), so neither
    // action can label one failure as another. Here the status check is pure
    // belt-and-braces: the only thing this route conflicts on is the username,
    // but it means the copy survives the backend's wording drifting, which it
    // already did once — a CONFLICT's message is replaced wholesale by Medusa's
    // error handler, so the first version of this reached the user as the
    // generic "Could not save your changes."
    const matched = friendlyError(error, PROFILE_RULES, '');
    if (matched) return { ok: false, error: matched };
    if (httpStatus(error) === 409 || httpStatus(error) === 422) {
      return { ok: false, error: USERNAME_TAKEN };
    }
    return {
      ok: false,
      error: 'Could not save your changes. Please try again.',
    };
  }
}
