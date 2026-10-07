import {
  GIFT_CLAIM_LEASE_MINUTES,
  giftNoteError,
  giftQuantityError,
  giftState,
  giftablePackError,
} from '../pack-gifts';
import { FREE_WELCOME_CATEGORY } from '../free-pack';

describe('pack gift rules', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it('names each gift state', () => {
    const base = { revoked_at: null, pull_id: null, opened_at: null };
    expect(giftState(base, now)).toBe('unopened');
    expect(giftState({ ...base, pull_id: 'pull_1' }, now)).toBe('opened');
    expect(giftState({ ...base, revoked_at: now }, now)).toBe('revoked');
    // claimed, open in flight
    expect(giftState({ ...base, opened_at: minutesAgo(1) }, now)).toBe(
      'opened',
    );
    // claimed long ago, never stamped: a crashed open
    expect(
      giftState(
        { ...base, opened_at: minutesAgo(GIFT_CLAIM_LEASE_MINUTES) },
        now,
      ),
    ).toBe('stuck');
    // revoked wins over everything
    expect(
      giftState({ revoked_at: now, pull_id: 'p', opened_at: now }, now),
    ).toBe('revoked');
  });

  it('only gifts active, ordinary packs', () => {
    expect(giftablePackError(undefined)).toMatch(/does not exist/);
    expect(
      giftablePackError({ status: 'active', category: FREE_WELCOME_CATEGORY }),
    ).toMatch(/cannot be gifted/);
    expect(
      giftablePackError({ status: 'active', category: 'reward_box' }),
    ).toMatch(/cannot be gifted/);
    expect(giftablePackError({ status: 'draft', category: 'pokemon' })).toMatch(
      /active/,
    );
    expect(giftablePackError({ status: 'active', category: 'pokemon' })).toBe(
      null,
    );
  });

  it('bounds quantity and requires a note', () => {
    expect(giftQuantityError(1)).toBe(null);
    expect(giftQuantityError(10)).toBe(null);
    for (const bad of [0, 11, 1.5, '2', null]) {
      expect(giftQuantityError(bad)).toMatch(/1 to 10/);
    }
    expect(giftNoteError('VIP thank-you')).toBe(null);
    expect(giftNoteError('  ')).toMatch(/required/);
    expect(giftNoteError(7)).toMatch(/required/);
    expect(giftNoteError('x'.repeat(513))).toMatch(/512/);
  });
});
