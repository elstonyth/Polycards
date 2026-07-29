import { MedusaError } from '@medusajs/framework/utils';
import {
  DELIVERY_STATUSES,
  type DeliveryStatus,
} from '../../../modules/packs/delivery';

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// Proof-image URLs are rendered in a customer-facing link/thumbnail, so a
// `javascript:`/`data:` scheme would be stored XSS from admin to customer.
// Accept only absolute http(s) URLs (what the media pipeline returns) or
// same-origin root-relative paths (dev static) — reject every other scheme.
const isSafeMediaUrl = (u: string): boolean => {
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
};

export type AdminDeliveryUpdate = {
  status?: DeliveryStatus;
  tracking_number?: string | null;
  proof_images?: string[];
};

// Validate the status query filter (?status=). Returns undefined when absent.
export function coerceStatusFilter(raw: unknown): DeliveryStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (
    typeof raw !== 'string' ||
    !DELIVERY_STATUSES.includes(raw as DeliveryStatus)
  ) {
    bad(`Invalid status filter '${String(raw)}'.`);
  }
  return raw as DeliveryStatus;
}

// Validate the id-search query filter (?q=). Returns undefined when absent.
// The value becomes the middle of a SQL LIKE pattern, so the three pattern
// metacharacters are escaped — `%` would silently widen the search and a lone
// trailing `\` is an invalid escape sequence Postgres errors on.
export function coerceIdSearch(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 64) {
    bad('`q` must be a string of at most 64 characters.');
  }
  return (raw as string).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Validate the per-player query filter (?customer_id=). Returns undefined only
// when the param is ABSENT. Deliberately stricter than the ?q=/?status=
// coercers above, which treat '' as absent: this one scopes the table to one
// player, and silently widening an empty value back to every customer's orders
// is a leak, not a convenience. A repeated param arrives as string[] → 400.
export function coerceCustomerId(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || trimmed.length > 64) {
    bad('`customer_id` must be a string of 1-64 characters.');
  }
  return trimmed;
}

export type BulkStatusBody = { ids: string[]; status: DeliveryStatus };

// Body of POST /admin/delivery-orders/bulk. The 100-id cap is the contract the
// route's sequential loop is sized for (one advisory-locked transaction per
// order); duplicates are rejected rather than de-duped so the caller's
// `updated`/`skipped` tally always lines up with what it sent.
export function coerceBulkStatusBody(raw: unknown): BulkStatusBody {
  if (!raw || typeof raw !== 'object') bad('Body must be an object.');
  const b = raw as Record<string, unknown>;
  if (
    !Array.isArray(b.ids) ||
    b.ids.length === 0 ||
    b.ids.length > 100 ||
    b.ids.some((v) => typeof v !== 'string') ||
    new Set(b.ids).size !== b.ids.length
  ) {
    bad('`ids` must be 1-100 unique strings.');
  }
  if (
    typeof b.status !== 'string' ||
    !DELIVERY_STATUSES.includes(b.status as DeliveryStatus)
  ) {
    bad(`Invalid status '${String(b.status)}'.`);
  }
  return { ids: b.ids as string[], status: b.status as DeliveryStatus };
}

export function coerceDeliveryUpdateBody(raw: unknown): AdminDeliveryUpdate {
  if (!raw || typeof raw !== 'object') bad('Body must be an object.');
  const b = raw as Record<string, unknown>;
  const out: AdminDeliveryUpdate = {};

  if (b.status !== undefined) {
    if (
      typeof b.status !== 'string' ||
      !DELIVERY_STATUSES.includes(b.status as DeliveryStatus)
    ) {
      bad(`Invalid status '${String(b.status)}'.`);
    }
    out.status = b.status as DeliveryStatus;
  }
  if (b.tracking_number !== undefined) {
    if (b.tracking_number !== null && typeof b.tracking_number !== 'string') {
      bad('`tracking_number` must be a string or null.');
    }
    out.tracking_number =
      typeof b.tracking_number === 'string'
        ? b.tracking_number.trim() || null
        : null;
  }
  if (b.proof_images !== undefined) {
    if (
      !Array.isArray(b.proof_images) ||
      b.proof_images.some(
        (u) => typeof u !== 'string' || !isSafeMediaUrl(u.trim()),
      )
    ) {
      bad('`proof_images` must be an array of http(s) URL strings.');
    }
    out.proof_images = (b.proof_images as string[]).map((u) => u.trim());
  }
  if (
    out.status === undefined &&
    out.tracking_number === undefined &&
    out.proof_images === undefined
  ) {
    bad('Provide `status`, `tracking_number`, and/or `proof_images`.');
  }
  return out;
}
