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
      'The payment gateway could not start this top-up. Please try again in a moment.',
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

  it('does not tell a customer to pick a payment method the UI lacks', () => {
    // TopUpSheet sends only an amount; the method is always
    // GLOBEPAY_DEFAULT_METHOD. Copy that suggests changing it is a dead end.
    expect(map('We could not start your top-up.')).not.toMatch(
      /payment method/i,
    );
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
    expect(map('Verify your phone number before continuing.')).toBe(
      'Verify your phone number in Account settings before topping up.',
    );
  });

  it('falls back for an unrecognised message', () => {
    expect(map('kaboom')).toBe(VAULT_FALLBACK);
  });
});
