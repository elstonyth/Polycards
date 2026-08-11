import { describe, it, expect } from 'vitest';
import { friendlyError } from '@/lib/errors';
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

  it('maps transport-level errors', () => {
    expect(map('Unauthorized')).toBe('Please log in to manage deliveries.');
    expect(map('rate limit exceeded (429)')).toBe(
      'Too many requests — give it a moment and try again.',
    );
    expect(map('Shipping address not found.')).toBe(
      'That card or address was not found.',
    );
  });

  // The phone gate is a NOT_ALLOWED, same class as "no longer available" —
  // so its rule has to win, or the customer is told to fix the wrong thing.
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
