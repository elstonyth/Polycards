import { describe, it, expect } from 'vitest';
import { NOTIFICATION_COPY, copyFor } from '../copy';

const TEMPLATES = [
  'vip_level_up',
  'commission_matured',
  'delivery_status',
  'reward_won',
  'voucher_claimed',
  'topup_credited',
  'withdrawal_paid',
  'withdrawal_refunded',
] as const;

// /vip, /vouchers, /daily, /referrals, /invite and /rewards all 404 while the
// reward economy is suspended (spec 2026-07-29) — a feed row must not deep-link
// to any of them. /rewards was a redirect STUB into /vip, which is exactly why
// the first version of this guard (literal equality against the deleted
// directories) missed it.
//
// Prefix + delimiter, not equality: `/vip/levels`, `/vip?source=notif` and
// `/vip#top` are all just as dead as `/vip`, while `/vip-status` — a route that
// merely shares the prefix — must NOT trip it.
const DEAD_ROUTE = /^\/(vip|vouchers|daily|referrals|invite|rewards)([/?#]|$)/;

describe('NOTIFICATION_COPY', () => {
  it('covers every template the backend can produce', () => {
    for (const t of TEMPLATES) {
      expect(NOTIFICATION_COPY[t], `missing copy for ${t}`).toBeTruthy();
    }
    // No extras — an orphan entry means a template was renamed or removed.
    expect(Object.keys(NOTIFICATION_COPY).sort()).toEqual(
      [...TEMPLATES].sort(),
    );
  });

  it('gives every entry a non-empty title and a valid variant and policy', () => {
    for (const t of TEMPLATES) {
      // Read through copyFor, not the raw index: the repo enables
      // noUncheckedIndexedAccess, and copyFor is what consumers call anyway.
      const c = copyFor(t);
      expect(c.title.length).toBeGreaterThan(0);
      expect(['success', 'info', 'reward']).toContain(c.variant);
      expect(['always', 'never']).toContain(c.policy);
      expect(c.icon).toBeTruthy();
    }
  });

  it('toasts exactly the templates nothing else announces', () => {
    const always = TEMPLATES.filter((t) => copyFor(t).policy === 'always');
    // voucher_claimed / topup_credited have their own client toast;
    // reward_won has PrizeReveal. Toasting them would double up. The two
    // withdrawal outcomes land asynchronously with no owning tab, so they
    // DO toast.
    expect(always.sort()).toEqual(
      [
        'commission_matured',
        'delivery_status',
        'vip_level_up',
        'withdrawal_paid',
        'withdrawal_refunded',
      ].sort(),
    );
  });

  it('pairs an action label with every href and neither without the other', () => {
    for (const t of TEMPLATES) {
      const c = copyFor(t);
      expect(Boolean(c.href)).toBe(Boolean(c.action));
    }
  });

  it('never links into the suspended VIP surfaces', () => {
    for (const t of TEMPLATES) {
      const c = copyFor(t);
      if (c.href) expect(c.href).not.toMatch(DEAD_ROUTE);
      // Body copy must not instruct a claim on the VIP page either.
      const body = c.body({
        amount_myr: 25,
        level: 3,
        levels: [3],
        prize_kind: 'voucher',
        status: 'shipped',
      });
      if (body) expect(body.toLowerCase()).not.toContain('vip page');
    }
  });

  it('rejects every URL variant that reaches a suspended surface', () => {
    // The delimiter class is the point: `(\/|$)` alone misses `/vip?x=1` and
    // `/vip#top`, and a `\b` boundary would over-match `/vip-status` — a
    // hypothetical LIVE route that merely starts with the same letters.
    for (const href of [
      '/vip',
      '/vip/levels',
      '/vip?source=notif',
      '/vip#rewards',
      '/vouchers',
      '/daily',
      '/referrals/tree',
      '/invite/abc123',
      '/rewards',
    ]) {
      expect(href).toMatch(DEAD_ROUTE);
    }
    for (const href of [
      '/vault',
      '/transactions',
      '/leaderboard',
      '/orders',
      '/vip-status',
      '/dailies',
    ]) {
      expect(href).not.toMatch(DEAD_ROUTE);
    }
  });
});

describe('body rendering', () => {
  it('vip_level_up reads naturally for one and for several levels', () => {
    const body = copyFor('vip_level_up').body;
    expect(body({ levels: [23] })).toBe('You reached level 23.');
    expect(body({ levels: [22, 23] })).toBe('You reached levels 22 and 23.');
    expect(body({ levels: [21, 22, 23] })).toBe(
      'You reached levels 21, 22 and 23.',
    );
  });

  it('commission_matured branches on the frozen flag', () => {
    const body = copyFor('commission_matured').body;
    expect(body({ frozen: false })).toBe(
      'Your commission is now available to spend.',
    );
    expect(body({ frozen: true })).toBe(
      'It will be available once your account is unfrozen.',
    );
  });

  it('delivery_status describes each notifiable status', () => {
    const body = copyFor('delivery_status').body;
    expect(body({ status: 'shipped', tracking_number: 'TRK1' })).toBe(
      'Your order is on its way. Tracking: TRK1',
    );
    expect(body({ status: 'shipped', tracking_number: null })).toBe(
      'Your order is on its way.',
    );
    // The terminal status is `completed` on the wire (operator vocabulary);
    // the customer is still told their order was "delivered".
    expect(body({ status: 'completed' })).toBe('Your order was delivered.');
    // Legacy token from persisted rows / rollback-era backends (expand window).
    expect(body({ status: 'delivered' })).toBe('Your order was delivered.');
    expect(body({ status: 'canceled' })).toBe(
      'Your delivery was canceled. Contact support if this was unexpected.',
    );
  });

  it('money bodies format as RM', () => {
    expect(copyFor('topup_credited').body({ amount_myr: 50 })).toBe(
      'RM 50.00 added to your balance.',
    );
    expect(copyFor('voucher_claimed').body({ amount_myr: 5, level: 3 })).toBe(
      'RM 5.00 credited from your Level 3 voucher.',
    );
    expect(copyFor('withdrawal_paid').body({ amount_myr: 50 })).toBe(
      'RM 50.00 has been sent to your bank.',
    );
    expect(copyFor('withdrawal_refunded').body({ amount_myr: 50 })).toBe(
      'The transfer could not be completed — RM 50.00 is back in your balance.',
    );
  });

  it('reward_won never calls a voucher win "credit"', () => {
    const body = copyFor('reward_won').body;
    // The draw builds a voucher prize as { kind: 'voucher', amount_myr } with
    // NO title, so this used to fall through to the amount branch and announce
    // a payment that never happened — nothing reaches the balance until the
    // grant is claimed (claiming is suspended alongside the VIP page).
    expect(body({ prize_kind: 'voucher', amount_myr: 5, title: '' })).toBe(
      'You won a RM 5.00 voucher.',
    );
    expect(body({ prize_kind: 'credit', amount_myr: 5, title: '' })).toBe(
      'You won RM 5.00 in credit.',
    );
    // A titled prize (product) still wins over both.
    expect(
      body({ prize_kind: 'product', title: 'Charizard PSA 10', amount_myr: 0 }),
    ).toBe('You won Charizard PSA 10.');
  });

  it('survives null, empty and malformed data without throwing', () => {
    for (const t of TEMPLATES) {
      const body = copyFor(t).body;
      expect(() => body(null)).not.toThrow();
      expect(() => body({})).not.toThrow();
      expect(() => body({ levels: 'nope', amount_myr: 'x' })).not.toThrow();
      // Never undefined: the renderers branch on `body && …`, so an undefined
      // return would render nothing while silently passing a truthiness check
      // that was meant to distinguish "no detail" from "broken payload".
      expect(body(null)).not.toBeUndefined();
      expect(body({ levels: 'nope', amount_myr: 'x' })).not.toBeUndefined();
    }
  });
});

describe('copyFor', () => {
  it('returns the registered entry', () => {
    expect(copyFor('vip_level_up').title).toBe('You leveled up!');
  });

  it('falls back safely for an unknown template rather than throwing', () => {
    const c = copyFor('some_future_template');
    expect(c.title).toBe('some_future_template');
    expect(c.policy).toBe('never');
    expect(c.href).toBeNull();
  });
});
