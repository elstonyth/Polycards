import { describe, it, expect } from 'vitest';
import { friendlyError, friendlyFailure } from '@/lib/errors';
import { DELIVERY_RULES, DELIVERY_FALLBACK } from '@/lib/delivery-errors';
import { isPhoneGateError } from '@/lib/phone-gate';

// Contract test for the message-substring coupling flagged in PR #130 review:
// the backend can't ship a machine-readable code through @medusajs/js-sdk
// (FetchError keeps only message/status), so the client matches message text.
// The exact strings below are pinned on the backend side by
// backend/.../workflows/steps/__tests__/request-delivery.unit.spec.ts — if
// either side rewords, one of the two suites goes red instead of the UI
// silently degrading to the generic fallback.
const map = (msg: string) =>
  friendlyError(new Error(msg), DELIVERY_RULES, DELIVERY_FALLBACK);

describe('shipping country and postcode refusals (2026-10-14)', () => {
  it('names both countries, from the new backend sentence or the old one', () => {
    for (const msg of [
      'We currently ship within Malaysia and Singapore only.',
      'We currently ship within Malaysia only.',
    ]) {
      expect(map(msg)).toMatch(/within Malaysia and Singapore only/);
    }
  });

  it("passes the country's postcode format through", () => {
    for (const msg of [
      'Enter a valid 6-digit Singapore postcode for this address.',
      'Enter a valid 5-digit Malaysian postcode for this address.',
    ]) {
      expect(map(msg)).toBe(msg);
    }
  });
});

describe('DELIVERY_RULES backend-message contract', () => {
  it('maps each per-status verdict message to its specific copy', () => {
    expect(
      map('One or more cards are already in a pending delivery request.'),
    ).toBe('One or more cards are already in a pending delivery request.');
    expect(map('One or more cards have already been delivered.')).toBe(
      'One or more cards have already been delivered.',
    );
    expect(map('One or more cards were already sold back.')).toBe(
      'One or more cards were already sold back.',
    );
    expect(map('One or more cards are no longer available to deliver.')).toBe(
      'One or more cards are no longer available to deliver.',
    );
  });

  it('keeps specific per-status rules ahead of the generic 409 rule', () => {
    // A message matching both a specific rule and the generic one must get
    // the specific copy — rule order is part of the contract.
    expect(
      map(
        'Not allowed: one or more cards are already in a pending delivery request.',
      ),
    ).toBe('One or more cards are already in a pending delivery request.');
  });

  // No rate-limit case here any more: that copy WAS the shared sentence, so
  // the rule left this table for the transport tier in lib/errors.ts and is
  // pinned once, by friendly-failure.test.ts. The 401 stays — this surface
  // words an expired session its own way, so the rule is still DELIVERY_RULES'.
  it('maps an expired session to the delivery login copy', () => {
    expect(map('Unauthorized')).toBe('Please log in to manage deliveries.');
    expect(map('Shipping address not found.')).toBe(
      'That card or address was not found.',
    );
  });

  // The phone gate is a NOT_ALLOWED, same class as "no longer available" —
  // so its rule has to win, or the customer is told to fix the wrong thing.
  // bonus-credit.ts BONUS_NOT_SPENDABLE_MESSAGE, a NOT_ALLOWED refusal the
  // broad /not allowed/ rule would misread as a card problem.
  it('says bonus credit cannot pay the delivery fee', () => {
    expect(
      map("Bonus credit can only be spent on packs — it can't pay for this."),
    ).toBe(
      "Bonus credit can only be used on packs, so it can't pay the delivery fee. Top up to pay it.",
    );
  });

  it('calls the fee the delivery fee everywhere', () => {
    expect(map("Deduction exceeds the customer's balance (RM 5.00)")).toBe(
      'Not enough balance to cover the delivery fee — top up and try again.',
    );
    for (const [, message] of DELIVERY_RULES) {
      if (typeof message === 'string') {
        expect(message).not.toMatch(/shipping fee/i);
      }
    }
  });

  it('passes the no-top-up refusal through instead of blaming the cards', () => {
    // withdrawable.ts NO_TOPUP_MESSAGE (backend), a NOT_ALLOWED refusal.
    for (const msg of [
      'Top up at least once to unlock deliveries. To withdraw, you also need to use all your money for packs.',
      // the pre-2026-10-15 wording, for deploy skew
      'Top up at least once to unlock withdrawals and deliveries.',
    ])
      expect(map(msg)).toBe(msg);
  });

  it('passes the daily prize-cap refusal through instead of blaming the cards', () => {
    // createDeliveryOrderWithLedger (backend), a NOT_ALLOWED refusal.
    const msg =
      'Prize cards ship 1 per day. Take the extra prize cards out and try again.';
    expect(map(msg)).toBe(msg);
  });

  it('keeps the phone-verification rule ahead of the broad not-allowed rule', () => {
    expect(map('Verify your phone number before continuing.')).toBe(
      'Verify your phone number in Account settings before requesting delivery.',
    );
    // PhoneGateAction renders the "add your phone number" button off this
    // sentence — display text is its only handle, so a reword that drops the
    // phrase takes the button with it. Same assertion guards VAULT_RULES.
    expect(
      isPhoneGateError(map('Verify your phone number before continuing.')),
    ).toBe(true);
    expect(isPhoneGateError(map('Shipping address not found.'))).toBe(false);
  });

  it('falls back on unknown text without leaking it', () => {
    expect(map('ECONNRESET raw socket detail')).toBe(DELIVERY_FALLBACK);
  });
});

it('composed delivery failure gives the domain verdict precedence over transport text', () => {
  expect(
    friendlyFailure(
      {
        ok: false,
        kind: 'rate_limited',
        status: 429,
        text: 'Too many requests: one or more cards have already been delivered.',
      },
      DELIVERY_RULES,
      DELIVERY_FALLBACK,
    ),
  ).toBe('One or more cards have already been delivered.');
});
