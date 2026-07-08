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
