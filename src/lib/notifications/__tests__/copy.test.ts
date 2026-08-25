import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFICATION_COPY, copyFor } from '../copy';

// The template list used to be hand-copied here as a `TEMPLATES` const.
// That mirror could drift from the backend's `FeedTemplate` union silently: a
// template added on the backend shipped green while the storefront feed fell
// through to unknown-key handling for a template announcing money events.
// Parse the union straight from backend source instead, so this file's
// "covers every template" assertion IS the parity check, not a copy of one.
const BACKEND_SRC = join(
  process.cwd(),
  'backend/packages/api/src/modules/packs/notify-feed.ts',
);

function backendFeedTemplates(): string[] {
  const src = readFileSync(BACKEND_SRC, 'utf8');
  const union = src.match(/export type FeedTemplate\s*=([\s\S]*?);/)?.[1];
  if (!union) {
    throw new Error(
      `FeedTemplate union not found in ${BACKEND_SRC}. If it was renamed or ` +
        `moved, update this guard -- do not delete it.`,
    );
  }
  const members = [...union.matchAll(/'([^']+)'/g)]
    .map((x) => x[1])
    .filter((x): x is string => x !== undefined);
  if (members.length === 0) {
    throw new Error(
      `FeedTemplate union parsed but yielded no members from ${BACKEND_SRC}. ` +
        `If the union shape changed, update this guard -- do not delete it.`,
    );
  }
  return members;
}

const TEMPLATES = backendFeedTemplates();

// /vip, /vouchers, /daily and /rewards all 404 while the reward economy is
// suspended (spec 2026-07-29) — a feed row must not deep-link to any of them.
// /rewards was a redirect STUB into /vip, which is exactly why the first
// version of this guard (literal equality against the deleted directories)
// missed it. (/referrals and /invite left this list when the referral engine
// was removed outright — they are free for the rebuilt system to claim.)
//
// Prefix + delimiter, not equality: `/vip/levels`, `/vip?source=notif` and
// `/vip#top` are all just as dead as `/vip`, while `/vip-status` — a route that
// merely shares the prefix — must NOT trip it.
const DEAD_ROUTE = /^\/(vip|vouchers|daily|rewards)([/?#]|$)/;

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
    // withdrawal outcomes land asynchronously with no owning tab, and
    // challenge_payout settles server-side between sessions — nothing else
    // announces any of them, so all three DO toast. The two bank_account_*
    // entries toast for a different reason: they are a security alert, and the
    // tab that needs to see them is the ACCOUNT OWNER's, not the one that
    // changed the destination. Both halves, because swapping the owner's payout
    // destination for the attacker's is a remove followed by an add.
    expect(always.sort()).toEqual(
      [
        'bank_account_added',
        'bank_account_removed',
        'challenge_payout',
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

  it('describes a challenge payout without linking to suspended surfaces', () => {
    const c = copyFor('challenge_payout');
    expect(c.href).toBe('/leaderboard');
    const body = c.body({ rank: 2, credits: 150, card_count: 1 });
    expect(body).toContain('#2');
    expect(body).toContain('RM');
  });

  it('challenge_payout composes credits and cards naturally', () => {
    const body = copyFor('challenge_payout').body;
    expect(body({ rank: 1, credits: 150, card_count: 0 })).toBe(
      'You finished #1 — RM 150.00 in credit added to your account.',
    );
    expect(body({ rank: 3, credits: 0, card_count: 2 })).toBe(
      'You finished #3 — 2 featured cards added to your account.',
    );
    expect(body({ rank: 2, credits: 50, card_count: 1 })).toBe(
      'You finished #2 — RM 50.00 in credit and a featured card added to your account.',
    );
    // Nothing granted (all cards skipped, no credits) → no detail line.
    expect(body({ rank: 4, credits: 0, card_count: 0 })).toBeNull();
    expect(body({ credits: 50, card_count: 1 })).toBeNull(); // rank missing
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
