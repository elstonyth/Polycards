/**
 * Error vocabulary for the delivery server actions, extracted from
 * actions/delivery.ts (a 'use server' file can only export async functions)
 * so the backend-message contract is unit-testable — see
 * __tests__/delivery-errors.test.ts.
 *
 * These patterns match backend message TEXT by necessity, not preference:
 * @medusajs/js-sdk's FetchError keeps only message/statusText/status from the
 * error response, so a machine-readable code field can't reach us through the
 * SDK. The exact strings are pinned by unit suites on BOTH sides (backend:
 * request-delivery.unit.spec.ts; storefront: delivery-errors.test.ts), so a
 * reword breaks a test instead of silently degrading to the fallback.
 */
import type { ErrorRule } from '@/lib/errors';

export const DELIVERY_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [
    /unauthorized|not authenticated|401/i,
    'Please log in to manage deliveries.',
  ],
  // Specific per-status reasons (sim P3 #9) — must precede the generic rule.
  [
    /already in a pending delivery/i,
    'One or more cards are already in a pending delivery request.',
  ],
  [/already been delivered/i, 'One or more cards have already been delivered.'],
  [/already sold back/i, 'One or more cards were already sold back.'],
  [
    /no longer available|not allowed|409/i,
    'One or more cards are no longer available to deliver.',
  ],
  [/not found|404/i, 'That card or address was not found.'],
  [
    /required|invalid|400/i,
    'Check your selection and address, then try again.',
  ],
];

export const DELIVERY_FALLBACK = 'Something went wrong. Please try again.';
