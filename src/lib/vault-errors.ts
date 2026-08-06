/**
 * Error vocabulary for the vault/credit server actions, extracted from
 * actions/vault.ts (a 'use server' file can only export async functions) so the
 * backend-message contract is unit-testable — see __tests__/vault-errors.test.ts.
 *
 * Same necessity as delivery-errors.ts: @medusajs/js-sdk's FetchError keeps only
 * message/statusText/status, so there is no machine-readable code to match on
 * and these patterns match backend message TEXT.
 *
 * ORDER IS THE CONTRACT. friendlyError returns the first match, and several
 * patterns here are deliberately broad, so a specific rule placed below a broad
 * one is dead. The 2026-08-04 GlobePay cutover shipped exactly that bug: the
 * gateway's refusal contains the word "amount", the broad /amount/i rule sat
 * above it, and a customer with a perfectly valid RM 50 top-up was told their
 * amount was malformed while the real cause (the gateway refusing the submit)
 * never reached the UI.
 */
import type { ErrorRule } from '@/lib/errors';

export const VAULT_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [/unauthorized|not authenticated|401/i, 'Please log in to view your vault.'],
  // requirePhoneVerified (backend api/utils/phone-verification-guard.ts) —
  // above every broad rule below, per the ORDER note in the file header. Names
  // the screen that fixes it: the gate clears the moment Settings completes the
  // SMS flow, and without the pointer this reads as a dead end.
  [
    /verify your phone/i,
    // "continuing", not "topping up": since 2026-08-05 the same guard sits on
    // the withdrawal submit too, and naming the wrong action reads as a bug.
    'Verify your phone number in Account settings before continuing.',
  ],
  [
    /declined/i,
    'Payment declined by the demo gateway — amounts ending in .13 always decline.',
  ],
  // Withdrawal messages are already customer-facing on the backend — pass
  // them through instead of flattening a gateway refusal into the fallback.
  [
    /could not start your withdrawal/i,
    'We could not start your withdrawal. Please check the bank details and try again.',
  ],
  [
    /withdrawals must be between/i,
    'Withdrawals must be between RM 30 and RM 1,000.',
  ],
  [/withdrawals are not open/i, 'Withdrawals are not open yet.'],
  [/insufficient/i, 'Not enough balance for that.'],
  // The operator kill switch, thrown by startGlobePayDeposit when
  // GLOBEPAY_ENABLED is off and by the deposit route when a callback URL is
  // missing. Without this rule the message matched NOTHING and fell through to
  // VAULT_FALLBACK ("Something went wrong. Please try again."), which made the
  // switch self-defeating: the one lever for "stop customers retrying a gateway
  // that cannot succeed" answered them with an invitation to retry. Found
  // during the 2026-08-05 outage, when every provisioned channel was returning
  // PMT10006 and turning top-ups off was the correct response.
  //
  // Deliberately promises no timeframe — the switch is flipped by a human and
  // stays off until another human flips it back.
  [
    /top-ups are temporarily unavailable/i,
    'Top-ups are paused right now — nothing was charged. Please try again later.',
  ],
  // MUST stay above /amount/i — see the ORDER note in the file header.
  //
  // Now it DOES point at the other channel, which it deliberately did not do
  // before: TopUpSheet had no method picker, so "choose another payment method"
  // named an action the UI could not perform. Since 2026-08-06 the sheet offers
  // QR and online banking, and a per-channel refusal is exactly the failure this
  // message covers — the other one may well work.
  //
  // The mock top-up path reaches this same rule with its own "could not start
  // your top-up", and has no picker. Accepted: the mock is the local/dev
  // gateway (NEXT_PUBLIC_PAYMENTS_PROVIDER != 'globepay'), so the stranded
  // advice can only ever be read by us, while the real path is the one taking
  // real money.
  [
    /could not start your top-up/i,
    'The payment gateway could not start this top-up. Try the other payment method, or try again in a moment.',
  ],
  [/amount/i, 'Enter a valid amount (up to RM 10,000, whole cents).'],
  [/already sold/i, 'This card was already sold back.'],
  [/not found|404/i, 'This card is no longer in your vault.'],
];

export const VAULT_FALLBACK = 'Something went wrong. Please try again.';
