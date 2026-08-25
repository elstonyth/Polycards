import {
  DEFAULT_REFERRAL_TIERS,
  lastClosedReferralWeek,
  payoutCents,
  referralWeekFor,
  resolveRateBp,
  taskWeekFor,
} from '../referral';

describe('resolveRateBp', () => {
  const t = DEFAULT_REFERRAL_TIERS;

  it.each([
    [0, 50],
    [599_900, 50], // RM0–5,999 → 0.5%
    [600_000, 100],
    [1_499_900, 100],
    [1_500_000, 150],
    [2_999_900, 150],
    [3_000_000, 200],
    [99_999_900, 200],
  ])('%i cents → %i bp', (cents, bp) => {
    expect(resolveRateBp(cents, t)).toBe(bp);
  });

  it('partner override replaces the table entirely', () => {
    expect(resolveRateBp(100, t, 400)).toBe(400);
    expect(resolveRateBp(99_999_900, t, 300)).toBe(300);
  });

  it('null/undefined partner falls through to tiers', () => {
    expect(resolveRateBp(0, t, null)).toBe(50);
    expect(resolveRateBp(0, t, undefined)).toBe(50);
  });

  it('an unsorted tier table still resolves by amount', () => {
    const shuffled = [t[2], t[0], t[3], t[1]];
    expect(resolveRateBp(2_000_000, shuffled)).toBe(150);
  });
});

describe('payoutCents', () => {
  it('floors to the cent', () => {
    expect(payoutCents(2_000_000, 150)).toBe(30_000); // RM20k @ 1.5% = RM300
    expect(payoutCents(999, 50)).toBe(4); // 4.995 → 4
    expect(payoutCents(0, 200)).toBe(0);
  });
});

describe('referral week (Tue 00:00 MYT → Tue 00:00 MYT)', () => {
  // 2026-08-24 is a Monday. Tue 2026-08-18 00:00 MYT = 2026-08-17T16:00:00Z.
  it('a Monday belongs to the week that started the previous Tuesday', () => {
    const w = referralWeekFor(new Date('2026-08-24T10:00:00Z'));
    expect(w.weekStartIso).toBe('2026-08-18');
    expect(w.startUtc.toISOString()).toBe('2026-08-17T16:00:00.000Z');
    expect(w.endUtcExcl.toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });

  it('Tuesday 00:00 MYT exactly starts a new week', () => {
    const w = referralWeekFor(new Date('2026-08-24T16:00:00Z')); // Tue 25th 00:00 MYT
    expect(w.weekStartIso).toBe('2026-08-25');
  });

  it('one instant before the boundary is still the old week', () => {
    const w = referralWeekFor(new Date('2026-08-24T15:59:59Z'));
    expect(w.weekStartIso).toBe('2026-08-18');
  });

  it('a Tuesday afternoon MYT is already the new week', () => {
    const w = referralWeekFor(new Date('2026-08-25T04:00:00Z')); // Tue noon MYT
    expect(w.weekStartIso).toBe('2026-08-25');
  });

  it('lastClosedReferralWeek is the week before the current one', () => {
    const w = lastClosedReferralWeek(new Date('2026-08-26T02:00:00Z')); // Wed MYT
    expect(w.weekStartIso).toBe('2026-08-18');
    expect(w.endUtcExcl.toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });
});

// The player-facing board sits on a DIFFERENT anchor from the money cycle —
// a regression here silently re-opens every weekly claim a day early.
describe('task week (Mon 00:00 MYT → Mon 00:00 MYT)', () => {
  it('a Monday morning MYT is already the new task week', () => {
    // 2026-08-24 is a Monday; 00:00 MYT = 2026-08-23T16:00:00Z.
    const w = taskWeekFor(new Date('2026-08-24T02:00:00Z')); // Mon 10:00 MYT
    expect(w.weekStartIso).toBe('2026-08-24');
    expect(w.startUtc.toISOString()).toBe('2026-08-23T16:00:00.000Z');
    expect(w.endUtcExcl.toISOString()).toBe('2026-08-30T16:00:00.000Z');
  });

  it('one instant before Monday 00:00 MYT is still the old week', () => {
    const w = taskWeekFor(new Date('2026-08-23T15:59:59Z'));
    expect(w.weekStartIso).toBe('2026-08-17');
  });

  it('is one day ahead of the settlement week mid-cycle', () => {
    const at = new Date('2026-08-26T02:00:00Z'); // Wed MYT
    expect(taskWeekFor(at).weekStartIso).toBe('2026-08-24'); // Mon
    expect(referralWeekFor(at).weekStartIso).toBe('2026-08-25'); // Tue
  });
});
