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
import {
  friendlyError,
  httpStatus,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import {
  NAME_MAX,
  usernameError,
  USERNAME_TAKEN,
} from '@/lib/profile-validation';
import { store } from '@/lib/store';
import { friendlyFailure } from '@/lib/errors';
import { RealNameSchema } from '@/lib/data/schemas';
import { normalizeRealName, REAL_NAME_INVALID } from '@/lib/real-name';

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

const PROFILE_RULES: ErrorRule[] = [
  // The shared probe (lib/errors.ts), this surface's own sentence. Stays a
  // RULES entry rather than a `kind` branch: this action catches a thrown
  // error rather than reading a port `Failure`, and the no-cookie case
  // (data/customer.ts throws a bare `Error('Not authenticated.')`, no status)
  // is only reachable through the text probe.
  [UNAUTHORIZED, 'Your session has expired. Please log in again.'],
  // The backend's username guard answers a taken name with this sentence.
  [/display name is already taken|username is taken/i, USERNAME_TAKEN],
  // …and the SAME outcome arrives as a raw Postgres error when two renames
  // race past that guard and the unique index refuses the loser. Without this
  // rule that user sees a database string; the guard cannot close the window
  // itself, so the copy has to cover both doors.
  //
  // Matched on the INDEX NAME, never on a bare /duplicate key value/ or
  // /unique constraint/: this route also writes `phone`, which has uniqueness
  // of its own, and a generic pattern would answer a phone collision by
  // telling the user their username was taken.
  [/IDX_customer_first_name_lower_unique/i, USERNAME_TAKEN],
];

export async function updateProfile(input: {
  first_name?: string;
  last_name?: string;
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
  // The display name keeps the profile handle's URL-safe shape, a hard rule,
  // not a preference. Checked here as well as in the backend's username guard
  // because a server action is a public endpoint in its own right.
  if (input.first_name !== undefined) {
    const bad = usernameError(input.first_name);
    if (bad) return { ok: false, error: bad };
  }
  // Never `phone`: the backend refuses any phone key on this route, whatever
  // the verification flag says (blockCustomerPhoneWrite), and would 400 the
  // WHOLE save. A phone is set only through `changePhone` (OTP-proven), and
  // once verified only customer service moves it (spec 2026-10-06).
  const body: HttpTypes.StoreUpdateCustomer = {
    first_name: clean(input.first_name),
    last_name: clean(input.last_name),
  };

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

export type RealNameResult =
  { ok: true; realName: string } | { ok: false; error: string };

const REAL_NAME_RULES: ErrorRule[] = [
  [UNAUTHORIZED, 'Your session has expired. Please log in again.'],
  // POST /store/customers/me/real-name's refusal once a name is on file.
  [
    /already on file/i,
    'Your real name is already saved. Contact customer service to correct it.',
  ],
  [/exactly as it appears/i, REAL_NAME_INVALID],
];

/**
 * The account's ONE-TIME real-name write (spec 2026-10-06). Called after the
 * customer confirmed the name (signup, the real-name gate, Settings); the
 * backend refuses a second write, so there is no edit path here at all.
 */
export async function saveRealName(input: {
  real_name: string;
}): Promise<RealNameResult> {
  const realName = normalizeRealName(input.real_name);
  if (!realName) return { ok: false, error: REAL_NAME_INVALID };
  const r = await store.post('/store/customers/me/real-name', RealNameSchema, {
    real_name: realName,
  });
  if (r.ok) return { ok: true, realName: r.data.real_name };
  return {
    ok: false,
    error: friendlyFailure(
      r,
      REAL_NAME_RULES,
      'Could not save your real name. Please try again.',
    ),
  };
}
