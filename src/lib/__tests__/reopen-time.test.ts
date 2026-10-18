import { describe, expect, it } from 'vitest';
import { reopenLabel } from '../reopen-time';

const at = (myt: string) => Date.parse(`${myt}+08:00`);
const iso = (myt: string) => new Date(at(myt)).toISOString();

describe('reopenLabel — when withdrawals reopen, Malaysia time', () => {
  const now = at('2026-10-17T22:00:00');

  it('says only the time when it is today', () => {
    expect(reopenLabel(iso('2026-10-17T23:30:00'), now)).toBe('11:30 PM');
  });

  it('says "tomorrow" across Malaysian midnight, not UTC midnight', () => {
    expect(reopenLabel(iso('2026-10-18T06:00:00'), now)).toBe(
      '6:00 AM tomorrow',
    );
    // 07:30 MYT is still "today" at 01:00 MYT, though UTC is a day behind.
    expect(
      reopenLabel(iso('2026-10-18T07:30:00'), at('2026-10-18T01:00:00')),
    ).toBe('7:30 AM');
  });

  it('names the day and date further out', () => {
    expect(reopenLabel(iso('2026-10-20T09:00:00'), now)).toBe(
      'Tue 20 Oct, 9:00 AM',
    );
  });
});
