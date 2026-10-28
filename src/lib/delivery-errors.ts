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
  // No top-up ever (2026-10-11): the refusal names its own fix. Above the
  // broad /not allowed|409/ rule, which would misread it as a card problem.
  [/top up at least once/i, (text) => text],
  // Daily prize cap (2026-10-23): prize cards ride in the delivery order and
  // the backend refuses the whole parcel past the cap; its sentence is the fix.
  [/prize cards ship \d+ per day/i, (text) => text],
  // Delivery-fee rules (2026-08-25) — must precede the generic /not allowed/
  // and /invalid|400/ rules, which would flatten them into wrong diagnoses.
  [
    /exceeds the customer's balance/i,
    'Not enough balance to cover the delivery fee — top up and try again.',
  ],
  // The delivery fee is paid from the normal balance only: bonus credit is
  // spend-only on packs (backend BONUS_NOT_SPENDABLE_MESSAGE).
  [
    /bonus credit can only be spent on packs/i,
    "Bonus credit can only be used on packs, so it can't pay the delivery fee. Top up to pay it.",
  ],
  [
    /within Malaysia( and Singapore)? only/i,
    'We currently ship within Malaysia and Singapore only — choose an address in one of them.',
  ],
  // The backend names the postcode format the country needs (5 digits for
  // Malaysia, 6 for Singapore); its sentence is already the fix.
  [/\d-digit (Malaysian|Singapore) postcode/i, (text) => text],
  // After the 12am cutoff the backend says the zone can no longer change
  // (contact support); before it, cancel-and-re-request is the fix. The
  // narrower rule must come first.
  [
    /fee zone, which can no longer change/i,
    'That address is in a different delivery fee zone, which can no longer change for this order — please contact support.',
  ],
  [
    /changes the shipping fee zone/i,
    'That address changes the delivery fee zone — cancel this delivery (the fee is refunded) and request it again with the new address.',
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
