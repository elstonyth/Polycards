'use server';

/**
 * Delivery server actions. Run server-side so the customer JWT stays in the
 * httpOnly cookie; the backend derives the customer id from the bearer token.
 *
 * Backend routes (customer-authenticated):
 *   POST /store/delivery-orders            — request batch delivery
 *   GET  /store/delivery-orders            — the caller's orders
 *   POST /store/delivery-orders/:id/address — edit address pre-ship
 *   POST /store/delivery-orders/:id/cancel  — cancel pre-ship (cards → vault)
 */
import type { HttpTypes } from '@medusajs/types';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken, getCustomer } from '@/lib/data/customer';
import {
  parseList,
  parseOne,
  DeliveryOrderSchema,
  type DeliveryOrderStatus,
} from '@/lib/data/schemas';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import { DELIVERY_RULES, DELIVERY_FALLBACK } from '@/lib/delivery-errors';
import { normalizePhone } from '@/lib/profile-validation';

export type DeliveryOrderItemView = {
  pullId: string;
  card: {
    handle: string;
    name: string;
    image: string;
    slabImage: string | null;
  } | null;
};
export type DeliveryOrderView = {
  id: string;
  // Derived from DeliveryOrderSchema so this can't drift from what actually
  // parses. Currently the transitional old ∪ new union (deploy skew) — every
  // consumer that switches on it must stay exhaustive over the widened set.
  status: DeliveryOrderStatus;
  trackingNumber: string | null;
  createdAt: string;
  items: DeliveryOrderItemView[];
  /** The shipping snapshot taken when the order was placed — NOT a live read of
   *  the address book, so editing or removing the book entry never rewrites it. */
  address: {
    name: string;
    line1: string;
    line2: string | null;
    city: string;
    province: string | null;
    postalCode: string;
    countryCode: string;
    phone: string | null;
  };
  // Operator-uploaded proof-of-delivery photo URLs (empty when none). Backend
  // key is `proof_images`; renamed here to match the camelCase view convention.
  proofImages: string[];
};

export type DeliveryOrdersResult =
  | { ok: true; orders: DeliveryOrderView[] }
  | { ok: false; error: string; needsAuth?: boolean };

export type RequestDeliveryResult =
  | { ok: true; orderId: string }
  | { ok: false; error: string; needsAuth?: boolean };

export type EditAddressResult =
  { ok: true } | { ok: false; error: string; needsAuth?: boolean };

export type AddressView = {
  id: string;
  /** `firstName lastName`, for display. */
  name: string;
  // Kept SPLIT as well as joined: the edit form has to seed the two inputs back,
  // and re-splitting `name` on whitespace mangles every two-word given name.
  firstName: string;
  lastName: string;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postalCode: string;
  countryCode: string;
  phone: string | null;
};

interface BackendDeliveryOrder {
  id: string;
  status: DeliveryOrderView['status'];
  tracking_number: string | null;
  proof_images?: string[] | null;
  created_at: string;
  address: {
    name: string;
    address_1?: string | null;
    address_2?: string | null;
    city: string;
    province?: string | null;
    postal_code?: string | null;
    country_code: string;
    phone?: string | null;
  };
  items: {
    pull_id: string;
    card: {
      handle: string;
      name: string;
      image: string;
      slab_image?: string | null;
    } | null;
  }[];
}

export async function getDeliveryOrders(): Promise<DeliveryOrdersResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your orders.',
      needsAuth: true,
    };
  }
  try {
    const res = await sdk.client.fetch('/store/delivery-orders', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const raw = parseList(
      DeliveryOrderSchema,
      (res as { items?: unknown }).items,
    ) as unknown as BackendDeliveryOrder[];
    const orders: DeliveryOrderView[] = raw.map((o) => ({
      id: o.id,
      status: o.status,
      trackingNumber: o.tracking_number,
      createdAt: o.created_at,
      address: {
        name: o.address?.name ?? '',
        line1: o.address?.address_1 ?? '',
        line2: o.address?.address_2 ?? null,
        city: o.address?.city ?? '',
        province: o.address?.province ?? null,
        postalCode: o.address?.postal_code ?? '',
        countryCode: o.address?.country_code ?? '',
        phone: o.address?.phone ?? null,
      },
      proofImages: o.proof_images ?? [],
      items: (o.items ?? []).map((it) => ({
        pullId: it.pull_id,
        card: it.card
          ? {
              handle: it.card.handle,
              name: it.card.name,
              image: it.card.image,
              slabImage: it.card.slab_image ?? null,
            }
          : null,
      })),
    }));
    return { ok: true, orders };
  } catch (error) {
    logger.error('[delivery] list failed:', error);
    return {
      ok: false,
      error: friendlyError(error, DELIVERY_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export async function requestDelivery(
  pullIds: string[],
  addressId: string,
): Promise<RequestDeliveryResult> {
  if (!Array.isArray(pullIds) || pullIds.length === 0) {
    return { ok: false, error: 'Select at least one card.' };
  }
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Choose a shipping address.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };

  try {
    const res = await sdk.client.fetch('/store/delivery-orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { pull_ids: pullIds, address_id: addressId },
    });
    const orderId = (res as { order_id?: string }).order_id;
    if (!orderId) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, orderId };
  } catch (error) {
    logger.error('[delivery] request failed:', error);
    return {
      ok: false,
      error: friendlyError(error, DELIVERY_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Re-point a pre-ship delivery order at a different saved address. The backend
// only permits this while the order is `requested` or `processed` (it returns
// NOT_ALLOWED→400 otherwise — from `ready_to_ship` on, a printed label must not
// diverge from the address); the UI hides the affordance for other statuses.
export async function editDeliveryAddress(
  orderId: string,
  addressId: string,
): Promise<EditAddressResult> {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { ok: false, error: 'Missing order.' };
  }
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Choose a shipping address.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };

  try {
    await sdk.client.fetch(
      `/store/delivery-orders/${encodeURIComponent(orderId)}/address`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { address_id: addressId },
      },
    );
    return { ok: true };
  } catch (error) {
    logger.error('[delivery] edit address failed:', error);
    return {
      ok: false,
      error: friendlyError(error, DELIVERY_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export type CancelDeliveryResult =
  | { ok: true; status: DeliveryOrderView['status'] }
  | { ok: false; error: string; needsAuth?: boolean };

// Cancel-specific error vocabulary — the generic DELIVERY_RULES map 404/409 to
// request-delivery copy ("card or address not found") that would mislead here.
// Order matters: "already canceled" must win before the broader shipped rule.
const CANCEL_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [
    /unauthorized|not authenticated|401/i,
    'Please log in to manage deliveries.',
  ],
  [/already canceled/i, 'This delivery is already canceled.'],
  // Backend NOT_ALLOWED once the order is out of the customer window. It fires
  // from `ready_to_ship` on — not only after the parcel physically ships — so
  // the copy says "being prepared", which is true for every status it covers.
  [
    /no longer be canceled|not allowed|ready to ship|shipped|delivered/i,
    'This order is already being prepared for shipping and can no longer be canceled — please contact support.',
  ],
  [/not found|404/i, 'That order was not found.'],
];

// Cancel an order the customer still owns the decision on (`requested`/
// `processed`) — the cards return to their vault. From `ready_to_ship` on the
// backend refuses: the parcel is picked and labelled, so cancelling is an
// operator/support action. The UI hides the affordance for the same statuses.
export async function cancelDeliveryOrder(
  orderId: string,
): Promise<CancelDeliveryResult> {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { ok: false, error: 'Missing order.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };

  try {
    const res = await sdk.client.fetch(
      `/store/delivery-orders/${encodeURIComponent(orderId)}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const order = parseOne(
      DeliveryOrderSchema,
      (res as { order?: unknown }).order,
    );
    // A 2xx means the cancel happened — a drifted body must not false-fail it,
    // so fall back to the status the backend just transitioned to.
    return { ok: true, status: order?.status ?? 'canceled' };
  } catch (error) {
    logger.error(`[delivery] cancel failed for '${orderId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, CANCEL_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Read the customer's address book (built-in Medusa field — no custom route).
export async function getAddresses(): Promise<AddressView[]> {
  const customer = await getCustomer();
  if (!customer) return [];
  return (customer.addresses ?? []).map(
    (a: HttpTypes.StoreCustomerAddress) => ({
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' '),
      firstName: a.first_name ?? '',
      lastName: a.last_name ?? '',
      line1: a.address_1 ?? '',
      line2: a.address_2 ?? null,
      city: a.city ?? '',
      province: a.province ?? null,
      postalCode: a.postal_code ?? '',
      countryCode: a.country_code ?? '',
      phone: a.phone ?? null,
    }),
  );
}

export type AddAddressInput = {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
};
export type AddAddressResult =
  | { ok: true; addressId: string }
  | { ok: false; error: string; needsAuth?: boolean };

export type EditAddressBookResult =
  { ok: true } | { ok: false; error: string; needsAuth?: boolean };

// ONE snake_case mapping for both create and update.
//
// The optional fields send an explicit `null`, NOT `undefined` — this is the
// load-bearing bit, not a style choice. `JSON.stringify` drops an `undefined`
// value entirely, and the update route is a PARTIAL write: a key that never
// reaches the wire leaves the stored value untouched. So `|| undefined` meant
// an operator clearing their phone number got a 200, an optimistic row showing
// it blank, and the old number still on the server after a reload. `null` is
// what "no value" has to look like on the update path, and Medusa's Create and
// Update schemas both type these `string | null`, so create is unaffected.
const addressBody = (input: AddAddressInput) => ({
  first_name: input.firstName,
  last_name: input.lastName,
  address_1: input.address1,
  address_2: input.address2 || null,
  city: input.city,
  province: input.province || null,
  postal_code: input.postalCode,
  country_code: input.countryCode,
  phone: input.phone || null,
});

// The four fields a parcel cannot ship without. Same gate on add and edit —
// an edit that blanks the street is as unshippable as an add that omits it.
const missingRequired = (input: AddAddressInput): boolean =>
  !input.address1?.trim() ||
  !input.city?.trim() ||
  !input.postalCode?.trim() ||
  !input.countryCode?.trim();

// The address-book phone is the actual SOURCE of a delivery order's
// ship_phone — the backend's profile-phone fallback (request-delivery.ts)
// only fires when it's BLANK, so a garbage address phone here would SUPPRESS
// that validated fallback. Same rule, same copy, as the profile phone
// (customer.ts): empty stays optional (→ null via addressBody below), a
// non-empty value must normalize to E.164 or the action rejects. Shared by
// both addAddress and updateAddress so the rule can't drift between them.
function validateAddressPhone(
  phone: string | undefined,
): { ok: true; phone: string | undefined } | { ok: false; error: string } {
  const trimmed = phone?.trim();
  if (!trimmed) return { ok: true, phone: undefined };
  const normalized = normalizePhone(trimmed);
  if (!normalized) {
    return {
      ok: false,
      error: 'Please enter a valid phone number for the selected country.',
    };
  }
  return { ok: true, phone: normalized };
}

// Create an address in the Medusa customer address book via the built-in SDK.
// Returns the new address id for immediate selection in the delivery flow.
export async function addAddress(
  input: AddAddressInput,
): Promise<AddAddressResult> {
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  if (missingRequired(input)) {
    return { ok: false, error: 'Fill in the required address fields.' };
  }
  const phoneCheck = validateAddressPhone(input.phone);
  if (!phoneCheck.ok) return phoneCheck;
  try {
    const { customer } = await sdk.store.customer.createAddress(
      addressBody({ ...input, phone: phoneCheck.phone }),
      {},
      { Authorization: `Bearer ${token}` },
    );
    const list = customer.addresses ?? [];
    const created = list[list.length - 1];
    if (!created?.id) {
      return { ok: false, error: 'Address was not saved. Please try again.' };
    }
    return { ok: true, addressId: created.id };
  } catch (error) {
    logger.error('[delivery] add address failed:', error);
    return {
      ok: false,
      error: friendlyError(error, DELIVERY_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Edit a saved address in place. NOTE: a delivery order snapshots the address
// at request time (ship_* columns on delivery_order), so this never re-routes a
// parcel that is already on its way — changing where an existing order ships is
// `editDeliveryAddress` above, which re-points it at a book entry.
export async function updateAddress(
  addressId: string,
  input: AddAddressInput,
): Promise<EditAddressBookResult> {
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Missing address.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  if (missingRequired(input)) {
    return { ok: false, error: 'Fill in the required address fields.' };
  }
  const phoneCheck = validateAddressPhone(input.phone);
  if (!phoneCheck.ok) return phoneCheck;
  try {
    await sdk.store.customer.updateAddress(
      addressId,
      addressBody({ ...input, phone: phoneCheck.phone }),
      {},
      { Authorization: `Bearer ${token}` },
    );
    return { ok: true };
  } catch (error) {
    logger.error(`[delivery] update address '${addressId}' failed:`, error);
    return {
      ok: false,
      error: friendlyError(error, DELIVERY_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Remove an address from the book. Safe against in-flight orders for the same
// reason as `updateAddress`: the order carries its own snapshot.
export async function deleteAddress(
  addressId: string,
): Promise<EditAddressBookResult> {
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Missing address.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  try {
    await sdk.store.customer.deleteAddress(addressId, {
      Authorization: `Bearer ${token}`,
    });
    return { ok: true };
  } catch (error) {
    logger.error(`[delivery] delete address '${addressId}' failed:`, error);
    return {
      ok: false,
      error: friendlyError(error, DELIVERY_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
