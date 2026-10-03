import { malaysiaDay } from '../day';

describe('malaysiaDay', () => {
  it('spans one Malaysia calendar day', () => {
    expect(malaysiaDay('2026-10-03')).toEqual({
      day: '2026-10-03',
      from: new Date('2026-10-02T16:00:00.000Z'),
      to: new Date('2026-10-03T16:00:00.000Z'),
      label: '3 OCT 2026',
    });
  });

  it('defaults to yesterday in Malaysia, whatever the UTC date', () => {
    // 00:30 MYT on 5 Oct is still 4 Oct in UTC.
    expect(
      malaysiaDay(undefined, new Date('2026-10-04T16:30:00.000Z')).day,
    ).toBe('2026-10-04');
    // 23:59 MYT on 4 Oct.
    expect(
      malaysiaDay(undefined, new Date('2026-10-04T15:59:00.000Z')).day,
    ).toBe('2026-10-03');
  });

  it('refuses anything that is not a real date', () => {
    for (const bad of ['2026-13-01', '2026-02-30', 'yesterday', '20261003']) {
      expect(() => malaysiaDay(bad)).toThrow(/day must be a date/);
    }
  });
});
