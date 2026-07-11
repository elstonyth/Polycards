'use server';

/**
 * Delivery server actions. Run server-side so the customer JWT stays in the
 * httpOnly cookie; the backend derives the customer id from the bearer token.
 *
 * Backend routes (customer-authenticated):
 *   POST /store/delivery-orders            — request batch delivery
 *   GET  /store/delivery-orders            — the caller's orders
 *   POST /store/delivery-orders/:id/address — edit address pre-ship
 */
import type { HttpTypes } from '@medusajs/types';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken, getCustomer } from '@/lib/data/customer';
import { parseList, DeliveryOrderSchema } from '@/lib/data/schemas';
import { friendlyError, isAuthError } from '@/lib/errors';
import { DELIVERY_RULES, DELIVERY_FALLBACK } from '@/lib/delivery-errors';

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
  status: 'requested' | 'packing' | 'shipped' | 'delivered' | 'canceled';
  trackingNumber: string | null;
  createdAt: string;
  items: DeliveryOrderItemView[];
  address: { name: string; city: string; countryCode: string };
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
  name: string;
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
  address: { name: string; city: string; country_code: string };
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
        city: o.address?.city ?? '',
        countryCode: o.address?.country_code ?? '',
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
// only permits this while the order is `requested` or `packing` (it returns
// NOT_ALLOWED→400 otherwise); the UI hides the affordance for other statuses.
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

// Read the customer's address book (built-in Medusa field — no custom route).
export async function getAddresses(): Promise<AddressView[]> {
  const customer = await getCustomer();
  if (!customer) return [];
  return (customer.addresses ?? []).map(
    (a: HttpTypes.StoreCustomerAddress) => ({
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' '),
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

// Create an address in the Medusa customer address book via the built-in SDK.
// Returns the new address id for immediate selection in the delivery flow.
export async function addAddress(
  input: AddAddressInput,
): Promise<AddAddressResult> {
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  if (
    !input.address1?.trim() ||
    !input.city?.trim() ||
    !input.postalCode?.trim() ||
    !input.countryCode?.trim()
  ) {
    return { ok: false, error: 'Fill in the required address fields.' };
  }
  try {
    const { customer } = await sdk.store.customer.createAddress(
      {
        first_name: input.firstName,
        last_name: input.lastName,
        address_1: input.address1,
        address_2: input.address2 || undefined,
        city: input.city,
        province: input.province || undefined,
        postal_code: input.postalCode,
        country_code: input.countryCode,
        phone: input.phone || undefined,
      },
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
