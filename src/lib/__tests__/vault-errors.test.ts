import { describe, it, expect } from 'vitest';
import { friendlyError } from '@/lib/errors';
import { VAULT_RULES, VAULT_FALLBACK } from '@/lib/vault-errors';

// Contract test for the same message-substring coupling as delivery-errors:
// @medusajs/js-sdk's FetchError keeps only message/status, so there is no code
// to match and the client matches backend TEXT. The strings below are the
// literal ones the backend throws — a reword breaks a test instead of silently
// degrading the UI.
//
// The ordering case is the reason this file exists. Shipped 2026-08-04: the
// GlobePay refusal contains the word "amount", the broad /amount/i rule sat
// above it, and a customer's valid RM 50 top-up was reported as a malformed
// amount while the gateway's actual refusal never surfaced.
const map = (msg: string) =>
  friendlyError(new Error(msg), VAULT_RULES, VAULT_FALLBACK);

describe('VAULT_RULES backend-message contract', () => {
  it('reports a gateway refusal as a gateway problem, not a bad amount', () => {
    // packs/globepay-deposit.ts, the GlobePayError branch.
    const refusal =
      'We could not start your top-up. Please try a different amount or payment method.';
    expect(map(refusal)).toBe(
      'The payment gateway could not start this top-up. Try the other payment method, or try again in a moment.',
    );
    // The precise regression: it must NOT fall through to the amount rule,
    // which is what a re-sort of the table would reintroduce.
    expect(map(refusal)).not.toBe(
      'Enter a valid amount (up to RM 10,000, whole cents).',
    );
  });

  it('still maps genuine amount-validation messages to the amount copy', () => {
    // packs/topup.ts topUpAmountError — narrowing the catch-all must not
    // disable it.
    expect(map('Amount must be greater than zero.')).toBe(
      'Enter a valid amount (up to RM 10,000, whole cents).',
    );
    expect(map('Amount must be at most RM 10,000 per top-up.')).toBe(
      'Enter a valid amount (up to RM 10,000, whole cents).',
    );
  });

  it('points a refused top-up at the other channel, which the UI now has', () => {
    // Inverted 2026-08-06: this used to assert the copy must NOT mention a
    // payment method, because TopUpSheet sent an amount only and the channel
    // was pinned to GLOBEPAY_DEPOSIT_METHOD — advice the UI could not act on.
    // The sheet now offers QR and online banking (src/lib/deposit-methods.ts),
    // so a per-channel refusal has a real next step. If the picker is ever
    // removed, revert this and the copy together.
    expect(map('We could not start your top-up.')).toMatch(/payment method/i);
  });

  it('keeps the withdrawal rules ahead of the broad ones', () => {
    expect(map('Withdrawals must be between RM 30 and RM 1,000.')).toBe(
      'Withdrawals must be between RM 30 and RM 1,000.',
    );
    expect(map('We could not start your withdrawal.')).toBe(
      'We could not start your withdrawal. Please check the bank details and try again.',
    );
  });

  it('points an unverified customer at the screen that clears the gate', () => {
    // Action-neutral copy: the same guard fires on topup AND withdrawal
    // (2026-08-05), so the message must not name either one.
    expect(map('Verify your phone number before continuing.')).toBe(
      'Verify your phone number in Account settings before continuing.',
    );
  });

  // The kill switch is the documented incident response for a dead gateway
  // (GLOBEPAY_ENABLED=false, an env flip with no deploy), and the 2026-08-05
  // GlobePay outage is the case it was built for. Until this rule existed the
  // switch was self-defeating: startGlobePayDeposit's deliberate, operator-
  // chosen message matched NO rule and was flattened into VAULT_FALLBACK —
  // "Something went wrong. Please try again." So the one control we have for
  // "stop customers retrying a gateway that cannot succeed" told them to retry.
  it('surfaces the top-ups-disabled kill switch instead of the generic fallback', () => {
    // packs/globepay-deposit.ts (globepayEnabled false) and
    // api/store/credits/deposit/route.ts (notify/return URL missing) both
    // throw this exact string.
    const paused = 'Top-ups are temporarily unavailable.';
    expect(map(paused)).not.toBe(VAULT_FALLBACK);
    expect(map(paused)).toBe(
      'Top-ups are paused right now — nothing was charged. Please try again later.',
    );
    // The whole point of the switch is to stop the retry loop, so the copy
    // must not invite an immediate retry the way the transient-refusal copy does.
    expect(map(paused)).not.toMatch(/in a moment/i);
    // The rule is deliberately case-insensitive, unlike a literal compare: this
    // matches backend TEXT, and a reword that only changes capitalisation must
    // not silently drop the customer back onto the generic fallback.
    expect(map('Top-Ups Are Temporarily Unavailable.')).toBe(map(paused));
  });

  it('falls back for an unrecognised message', () => {
    expect(map('kaboom')).toBe(VAULT_FALLBACK);
  });
});
