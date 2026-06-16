import { MedusaError } from '@medusajs/framework/utils';
import {
  DELIVERY_STATUSES,
  type DeliveryStatus,
} from '../../../modules/packs/delivery';

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

export type AdminDeliveryUpdate = {
  status?: DeliveryStatus;
  tracking_number?: string | null;
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
  if (out.status === undefined && out.tracking_number === undefined) {
    bad('Provide `status` and/or `tracking_number`.');
  }
  return out;
}
