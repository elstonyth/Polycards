import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';

// Medusa's stock customer-address routes accept null/missing country_code and
// postal_code (200, no warning), silently storing an address the delivery
// pipeline can't ship to (sim finding P3-8). Guard both fields before the core
// route runs: on create they must be present; on update they may be omitted
// (partial update) but never blanked out.
export function validateDeliverableAddress(mode: 'create' | 'update') {
  return (
    req: MedusaRequest,
    _res: MedusaResponse,
    next: MedusaNextFunction,
  ): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const field of ['country_code', 'postal_code'] as const) {
      const provided = field in body && body[field] !== undefined;
      if (!provided && mode === 'update') continue;
      const value = body[field];
      if (typeof value !== 'string' || value.trim() === '') {
        next(
          new MedusaError(
            MedusaError.Types.INVALID_DATA,
            'A shipping address needs a country and postal code.',
          ),
        );
        return;
      }
    }
    next();
  };
}
