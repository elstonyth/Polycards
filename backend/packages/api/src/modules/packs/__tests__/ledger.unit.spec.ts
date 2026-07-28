import {
  nextSerial,
  ymqInMyt,
  sequenceScope,
  displayId,
  countByHandle,
  parseMytBound,
} from '../ledger';

describe('ledger — nextSerial (spec §5.2 rollovers)', () => {
  it('starts a fresh scope at a0001', () => {
    expect(nextSerial(null)).toBe('a0001');
  });
  it('increments the digit block', () => {
    expect(nextSerial('a0001')).toBe('a0002');
    expect(nextSerial('a0412')).toBe('a0413');
  });
  it('rolls the letter block at 9999 (a9999 -> b0001)', () => {
    expect(nextSerial('a9999')).toBe('b0001');
  });
  it('rolls a second letter block at 9999 (z... never happens before aa;'
    + ' the letter block itself rolls z -> aa)', () => {
    expect(nextSerial('z9999')).toBe('aa0001');
  });
  it('carries a multi-letter block (az9999 -> ba0001)', () => {
    expect(nextSerial('az9999')).toBe('ba0001');
  });
  it('rejects a malformed stored serial rather than silently reusing it', () => {
    expect(() => nextSerial('A0001')).toThrow();
    expect(() => nextSerial('a1')).toThrow();
    expect(() => nextSerial('0001')).toThrow();
  });
});

describe('ledger — MYT year/quarter derivation', () => {
  it('reads a mid-quarter UTC instant correctly', () => {
    // 2026-08-15 12:00 UTC = 2026-08-15 20:00 MYT -> Q3
    expect(ymqInMyt(new Date('2026-08-15T12:00:00Z'))).toEqual({ yy: '26', q: 3 });
  });
  it('the MYT day boundary can roll the quarter relative to UTC', () => {
    // 2026-09-30 17:00 UTC = 2026-10-01 01:00 MYT -> Q4, even though the UTC
    // instant is still September (the whole reason occurred_at math must be
    // done in Asia/Kuala_Lumpur, not UTC — POLYCARD-BACK baked default).
    expect(ymqInMyt(new Date('2026-09-30T17:00:00Z'))).toEqual({ yy: '26', q: 4 });
  });
  it('the MYT year boundary can roll the year relative to UTC', () => {
    // 2026-12-31 17:30 UTC = 2027-01-01 01:30 MYT -> next year, Q1.
    expect(ymqInMyt(new Date('2026-12-31T17:30:00Z'))).toEqual({ yy: '27', q: 1 });
  });
  it('sequenceScope combines type + yy + quarter', () => {
    expect(sequenceScope('TP', new Date('2026-08-15T12:00:00Z'))).toBe('TP-26-Q3');
  });
  it('a scope changes across a quarter rollover', () => {
    const a = sequenceScope('AD', new Date('2026-09-30T17:00:00Z'));
    const b = sequenceScope('AD', new Date('2026-09-30T15:00:00Z'));
    expect(a).not.toBe(b); // Q4 vs Q3 for instants 2h apart
  });
});

describe('ledger — parseMytBound (admin date-range filter)', () => {
  it('reads a date-only bound as the operator MYT calendar day', () => {
    // 2026-07-28 00:00 MYT is 2026-07-27 16:00 UTC — a plain new Date() on the
    // same string would have said 2026-07-28 00:00 UTC, 8h late.
    expect(parseMytBound('2026-07-28', 'from')?.toISOString()).toBe(
      '2026-07-27T16:00:00.000Z',
    );
    // `to` is the NEXT MYT midnight, exclusive — the whole point of the fix.
    expect(parseMytBound('2026-07-28', 'to')?.toISOString()).toBe(
      '2026-07-28T16:00:00.000Z',
    );
  });

  it('a single-day window covers that MYT day and nothing either side', () => {
    // The bug this replaces: from=X&to=X was a zero-width window (both bounds
    // on the same midnight), so a one-day filter returned nothing at all.
    const from = parseMytBound('2026-07-28', 'from') as Date;
    const to = parseMytBound('2026-07-28', 'to') as Date;
    expect(to.getTime()).toBeGreaterThan(from.getTime());
    // Half-open [from, to): the service pairs these with `>=` and `<`.
    const inWindow = (iso: string): boolean => {
      const t = new Date(iso).getTime();
      return t >= from.getTime() && t < to.getTime();
    };
    expect(inWindow('2026-07-28T03:00:00Z')).toBe(true); // 11:00 MYT, mid-day
    expect(inWindow('2026-07-27T16:00:00Z')).toBe(true); // 00:00 MYT, first tick
    expect(inWindow('2026-07-28T15:59:59.999Z')).toBe(true); // 23:59:59.999 MYT
    expect(inWindow('2026-07-27T15:59:59.999Z')).toBe(false); // day before
    expect(inWindow('2026-07-28T16:00:00Z')).toBe(false); // 00:00 MYT next day
  });

  it('takes a full instant literally rather than as a calendar day', () => {
    expect(parseMytBound('2026-07-28T10:00:00Z', 'to')?.toISOString()).toBe(
      '2026-07-28T10:00:00.000Z',
    );
  });

  it('drops junk instead of binding an Invalid Date to pg', () => {
    // These must stay undefined: an Invalid Date bound to a timestamptz param
    // makes pg throw, i.e. a 500 on `?from=abc` rather than an ignored filter.
    expect(parseMytBound('not-a-date', 'from')).toBeUndefined();
    expect(parseMytBound('2026-13-01', 'from')).toBeUndefined(); // regex ok, date not
    expect(parseMytBound('', 'from')).toBeUndefined();
    expect(parseMytBound('   ', 'to')).toBeUndefined();
    expect(parseMytBound(undefined, 'from')).toBeUndefined();
    expect(parseMytBound(['2026-07-28'], 'from')).toBeUndefined();
  });
});

describe('ledger — displayId', () => {
  it('renders TYPE + YY + Q# + UPPERCASE serial (spec example: TP26Q3A0001)', () => {
    expect(displayId('TP', new Date('2026-08-15T12:00:00Z'), 'a0001')).toBe('TP26Q3A0001');
  });
});

describe('ledger — countByHandle', () => {
  it('tallies quantity per distinct handle, first-seen order', () => {
    expect(countByHandle(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual([
      { card_handle: 'a', qty: 3 },
      { card_handle: 'b', qty: 2 },
      { card_handle: 'c', qty: 1 },
    ]);
  });
  it('returns [] for an empty list', () => {
    expect(countByHandle([])).toEqual([]);
  });
});
