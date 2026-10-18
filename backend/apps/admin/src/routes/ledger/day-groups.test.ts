import { describe, expect, it } from 'vitest';
import { groupByDay, mytDay } from './day-groups';

describe('mytDay', () => {
  it('is the Malaysia calendar day (UTC+8)', () => {
    expect(mytDay('2026-10-13T15:59:00Z')).toBe('2026-10-13');
    expect(mytDay('2026-10-13T16:00:00Z')).toBe('2026-10-14');
  });
});

describe('groupByDay', () => {
  const row = (id: string, at: string) => ({ id, occurred_at: at });

  it('groups consecutive rows under their day, newest first as given', () => {
    const groups = groupByDay([
      row('a', '2026-10-14T05:00:00Z'),
      row('b', '2026-10-14T01:00:00Z'),
      row('c', '2026-10-13T05:00:00Z'),
    ]);
    expect(groups.map((g) => [g.day, g.rows.map((r) => r.id)])).toEqual([
      ['2026-10-14', ['a', 'b']],
      ['2026-10-13', ['c']],
    ]);
  });

  it('keeps the order it was given: a day seen twice (sorted by type) is two groups', () => {
    const groups = groupByDay([
      row('a', '2026-10-14T05:00:00Z'),
      row('b', '2026-10-13T05:00:00Z'),
      row('c', '2026-10-14T06:00:00Z'),
    ]);
    expect(groups.map((g) => g.day)).toEqual([
      '2026-10-14',
      '2026-10-13',
      '2026-10-14',
    ]);
  });

  it('nothing in, nothing out', () => {
    expect(groupByDay([])).toEqual([]);
  });
});
