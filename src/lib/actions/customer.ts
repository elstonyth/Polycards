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

const MAX_FIELD_LENGTH = 120;

export type ProfileCustomer = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
};

export type ProfileResult =
  | { ok: true; customer: ProfileCustomer }
  | { ok: false; error: string };

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
  return trimmed === '' ? null : trimmed.slice(0, MAX_FIELD_LENGTH);
};

function friendlyError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/not authenticated|unauthorized|401/i.test(text))
    return 'Your session has expired. Please log in again.';
  return fallback;
}

export async function updateProfile(input: {
  first_name?: string;
  last_name?: string;
  phone?: string;
}): Promise<ProfileResult> {
  const body: HttpTypes.StoreUpdateCustomer = {
    first_name: clean(input.first_name),
    last_name: clean(input.last_name),
    phone: clean(input.phone),
  };

  try {
    const customer = await updateCustomerProfile(body);
    return { ok: true, customer: toProfileCustomer(customer) };
  } catch (error) {
    logger.error('[profile] update failed:', error);
    return {
      ok: false,
      error: friendlyError(
        error,
        'Could not save your changes. Please try again.',
      ),
    };
  }
}
