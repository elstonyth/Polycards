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
  // MUST stay above /amount/i — see the ORDER note in the file header.
  //
  // The copy deliberately does NOT suggest choosing another payment method,
  // even though the backend message does: TopUpSheet has no method picker, the
  // method is always GLOBEPAY_DEFAULT_METHOD, so that advice would strand the
  // customer on an action the UI cannot perform. Generic wording also keeps
  // this correct for the mock top-up path, whose own "could not start your
  // top-up" message reaches the same table.
  [
    /could not start your top-up/i,
    'The payment gateway could not start this top-up. Please try again in a moment.',
  ],
  [/amount/i, 'Enter a valid amount (up to RM 10,000, whole cents).'],
  [/already sold/i, 'This card was already sold back.'],
  [/not found|404/i, 'This card is no longer in your vault.'],
];

export const VAULT_FALLBACK = 'Something went wrong. Please try again.';
