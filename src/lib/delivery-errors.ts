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
import { COPY, UNAUTHORIZED, type ErrorRule } from '@/lib/errors';

/** This surface's own word for an expired session — shared with CANCEL_RULES
 *  in actions/delivery.ts, which answers the same 401 the same way. */
export const DELIVERY_LOGIN = 'Please log in to manage deliveries.';

// No rate-limit rule: this table's copy WAS the shared sentence, so the
// transport tier in lib/errors.ts answers a 429 now (friendlyFailure) — but
// only LAST: friendlyFailure runs every rule below first, so the transport
// tier now sits behind every one of them, including the three numeric ones at
// the tail (/no longer available|not allowed|409/i, /not found|404/i,
// /required|invalid|400/i). The 401 rule stays because the sentence is this
// surface's own, not the shared one.
//
// Latent hazard, not live today: a rate-limited response reads
// "<label> Try again in Ns." (backend rate-limit.ts), and if N ever reached
// 400, 404, or 409 it would hit one of those three rules before the transport
// tier saw it. Every delivery rate limit defaults to a <=60s window
// (rate-limit.ts) — an env override could widen it — so N never grows past
// two digits today; re-check this comment if a window ever widens past ~400s.
export const DELIVERY_RULES: ErrorRule[] = [
  [UNAUTHORIZED, DELIVERY_LOGIN],
  // requirePhoneVerified (backend api/utils/phone-verification-guard.ts). MUST
  // stay above the broad /not allowed|409/ rule below, which would otherwise
  // flatten it into "cards are no longer available to deliver" — a wrong
  // diagnosis the customer cannot act on.
  [
    /verify your phone/i,
    'Verify your phone number in Account settings before requesting delivery.',
  ],
  // Shipping-fee rules (2026-08-25) — must precede the generic /not allowed/
  // and /invalid|400/ rules, which would flatten them into wrong diagnoses.
  [
    /exceeds the customer's balance/i,
    'Not enough credit to cover the shipping fee — top up and try again.',
  ],
  [
    /within Malaysia only/i,
    'We currently ship within Malaysia only — choose a Malaysian address.',
  ],
  [
    /changes the shipping fee zone/i,
    'That address changes the shipping fee zone — cancel this delivery (the fee is refunded) and request it again with the new address.',
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

export const DELIVERY_FALLBACK = COPY.generic;
