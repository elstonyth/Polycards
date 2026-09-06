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
 * one is dead. The 2026-08-04 gateway cutover shipped exactly that bug: the
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
    // Matches the backend's post-095 wording AND the pre-095 one still in
    // flight from an older deployment, so a mid-deploy refusal never falls
    // through to the generic "Something went wrong".
    /refused by the payment provider|could not start your withdrawal/i,
    // Says who refused and that the money is back, and stops short of telling
    // the customer to fix bank details that may be perfectly correct: on
    // 2026-08-11 two customers retried ten times against a payout channel that
    // was refusing everything, because the old copy read as their mistake.
    'Your withdrawal was refused by the payment provider and your balance has been returned. Check your bank details are correct — if they are, contact support rather than retrying.',
  ],
  [/withdrawals are not open/i, 'Withdrawals are not open yet.'],
  // The band message names the ACTIVE gateway's own floor and ceiling
  // (gateways differ), so it passes through verbatim — a fixed
  // rewrite here once told a customer "RM 30 – RM 1,000" for a refusal that
  // was really "RM 50 – RM 30,000". Above the broad /amount/ rule on purpose.
  [/(top-ups|withdrawals) must be between/i, (text) => text],
  [/insufficient/i, 'Not enough balance for that.'],
  // The operator kill switch, thrown by the deposit orchestration when
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
  // The copy deliberately does NOT suggest choosing another payment method,
  // even though the backend message does. That held when TopUpSheet had no
  // picker, and it still holds now that it has one: how many channels are on
  // offer is decided per request (DEPOSIT_METHODS_ENABLED), so "try the other
  // one" is advice this table cannot know is true — and when it IS true the
  // tiles are sitting directly above this error anyway. Generic wording also
  // keeps it correct for the mock top-up path, whose own "could not start your
  // top-up" message reaches the same table with no picker at all.
  [
    /could not start your top-up/i,
    'The payment gateway could not start this top-up. Please try again in a moment.',
  ],
  [/amount/i, 'Enter a valid amount (up to RM 10,000, whole cents).'],
  [/already sold/i, 'This card was already sold back.'],
  [/not found|404/i, 'This card is no longer in your vault.'],
];

export const VAULT_FALLBACK = 'Something went wrong. Please try again.';
