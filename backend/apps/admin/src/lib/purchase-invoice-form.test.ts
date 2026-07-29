import { describe, expect, test } from 'vitest';
import {
  draftError,
  moneyError,
  mytMidnightIso,
  mytToday,
  qtyError,
  type DraftLine,
} from './purchase-invoice-form';

// A date every draftError case below can pass in without thinking about it.
// Named rather than inlined so a site that loses it fails LOUDLY at the call
// signature instead of quietly re-pointing a supplier/qty/money assertion at
// the date message.
const VALID_DATE = '2026-07-28';

const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  card_handle: 'charizard-psa-10',
  card_name: 'Charizard',
  fmv_snapshot: '150',
  qty: '2',
  unit_cost: '120.50',
  ...over,
});

describe('moneyError', () => {
  test('accepts whole ringgit, one and two decimals', () => {
    for (const v of ['0', '150', '10.1', '120.50', '999999.99']) {
      expect(moneyError(v, 'Cost')).toBeNull();
    }
  });

  test('REJECTS a third decimal — the sub-sen class Task 2 measured at 100% error', () => {
    expect(moneyError('1.005', 'Cost')).toBe(
      'Cost may carry at most 2 decimals.',
    );
    expect(moneyError('1.004', 'Cost')).toBe(
      'Cost may carry at most 2 decimals.',
    );
  });

  test('does NOT reject values whose sen product is a float artefact', () => {
    // 0.07 * 100 === 7.000000000000001 and 4.35 * 100 === 434.99999999999994.
    // An exact `Number.isInteger(n * 100)` test would call both 3dp and refuse
    // two perfectly ordinary prices; the 1e-6 epsilon is what stops it. (10.1
    // does NOT demonstrate it — 10.1 * 100 is exactly 1010 — which is why this
    // validator's comment and validate.ts's both cite these two instead.)
    expect(0.07 * 100).toBe(7.000000000000001);
    expect(4.35 * 100).toBe(434.99999999999994);
    expect(10.1 * 100).toBe(1010);
    expect(Number.isInteger(0.07 * 100)).toBe(false);
    expect(Number.isInteger(4.35 * 100)).toBe(false);
    expect(moneyError('0.07', 'Cost')).toBeNull();
    expect(moneyError('4.35', 'Cost')).toBeNull();
  });

  test('rejects blank, non-numeric, negative and over-cap', () => {
    expect(moneyError('   ', 'Cost')).toBe('Cost is required.');
    expect(moneyError('abc', 'Cost')).toBe('Cost must be a number >= 0.');
    expect(moneyError('-1', 'Cost')).toBe('Cost must be a number >= 0.');
    expect(moneyError('Infinity', 'Cost')).toBe('Cost must be a number >= 0.');
    expect(moneyError('1000000.01', 'Cost')).toBe(
      'Cost is too large (max 1000000).',
    );
  });
});

describe('qtyError', () => {
  test('accepts non-zero integers in both signs', () => {
    for (const v of ['1', '250', '-1', '-10']) {
      expect(qtyError(v, 'Qty')).toBeNull();
    }
  });

  test('rejects zero, blank, fractional and over-cap', () => {
    expect(qtyError('0', 'Qty')).toBe('Qty must be a non-zero whole number.');
    expect(qtyError('', 'Qty')).toBe('Qty is required.');
    expect(qtyError('1.5', 'Qty')).toBe('Qty must be a non-zero whole number.');
    expect(qtyError('abc', 'Qty')).toBe('Qty must be a non-zero whole number.');
    expect(qtyError('1000001', 'Qty')).toBe('Qty is too large (max 1000000).');
  });
});

describe('draftError', () => {
  test('passes a well-formed draft', () => {
    expect(draftError(VALID_DATE, 'Acme Cards', [line()])).toBeNull();
  });

  test('requires a supplier and at least one line', () => {
    expect(draftError(VALID_DATE, '  ', [line()])).toBe(
      'Supplier is required.',
    );
    expect(draftError(VALID_DATE, 'Acme Cards', [])).toBe(
      'Add at least one line.',
    );
  });

  test('names the offending ROW, not just the field', () => {
    expect(
      draftError(VALID_DATE, 'Acme', [line(), line({ unit_cost: '1.005' })]),
    ).toBe('Line 2 unit cost may carry at most 2 decimals.');
    expect(draftError(VALID_DATE, 'Acme', [line({ qty: '0' })])).toBe(
      'Line 1 qty must be a non-zero whole number.',
    );
    expect(draftError(VALID_DATE, 'Acme', [line({ fmv_snapshot: '2.001' })])).toBe(
      'Line 1 FMV may carry at most 2 decimals.',
    );
  });
});

describe('draftError: the invoice date', () => {
  const MALFORMED = 'Invoice date must be a valid date (YYYY-MM-DD).';

  test('REJECTS a cleared date — the silent-no-op class', () => {
    // Regression pin. Before this guard draftError returned null, submit()
    // entered its try, mytMidnightIso('') threw RangeError, and the bare catch
    // swallowed it: no toast, no network request, no navigation, and the Save
    // button stayed enabled (its `disabled` has no date term). Clicking again
    // did nothing, forever.
    expect(draftError('', 'Acme', [line()])).toBe('Invoice date is required.');
    expect(draftError('   ', 'Acme', [line()])).toBe(
      'Invoice date is required.',
    );
  });

  test('BOTH clauses of the guard are load-bearing', () => {
    // Date.parse ACCEPTS this one, so the shape regex is the only thing that
    // rejects it — and mytMidnightIso throws on it (see the composition test).
    expect(Number.isNaN(Date.parse('2026-2-3'))).toBe(false);
    expect(draftError('2026-2-3', 'Acme', [line()])).toBe(MALFORMED);

    // ...and this one is regex-shaped, so Date.parse is the only thing that
    // rejects it.
    expect(/^\d{4}-\d{2}-\d{2}$/.test('2026-13-45')).toBe(true);
    expect(draftError('2026-13-45', 'Acme', [line()])).toBe(MALFORMED);

    expect(draftError('abc', 'Acme', [line()])).toBe(MALFORMED);
  });

  test('is checked BEFORE the supplier, matching the order on the page', () => {
    expect(draftError('', '', [])).toBe('Invoice date is required.');
  });

  test('ACCEPT SET MATCHES mytMidnightIso — the actual bug was these two disagreeing', () => {
    // Asserting each half separately is what let the hole exist: draftError
    // said "fine" for values mytMidnightIso threw on. So assert the
    // composition, in both directions.
    for (const d of [
      '2026-01-01',
      '2026-07-28',
      '2026-12-31',
      '1999-06-15',
      '2026-02-30', // rolls to 1 March; accepted deliberately, see the source.
    ]) {
      expect(draftError(d, 'Acme', [line()])).toBeNull();
      expect(() => mytMidnightIso(d)).not.toThrow();
    }
    for (const d of ['', '   ', 'abc', '2026-2-3', '2026-13-45', '0000-00-00']) {
      expect(draftError(d, 'Acme', [line()])).not.toBeNull();
      expect(() => mytMidnightIso(d)).toThrow(RangeError);
    }
  });
});

describe('mytMidnightIso', () => {
  test('anchors to MYT midnight, which is 16:00 UTC the PREVIOUS day', () => {
    expect(mytMidnightIso('2026-07-28')).toBe('2026-07-27T16:00:00.000Z');
  });

  test('is NOT the UTC-midnight reading the naive parse produces', () => {
    // This is the whole point of the helper: `new Date('2026-07-28')` is
    // 00:00Z, which a viewer at UTC-5 renders as 27 July.
    expect(mytMidnightIso('2026-07-28')).not.toBe(
      new Date('2026-07-28').toISOString(),
    );
    expect(new Date('2026-07-28T00:00:00.000Z').getUTCDate()).toBe(28);
    expect(new Date(mytMidnightIso('2026-07-28')).getUTCDate()).toBe(27);
  });

  test('round-trips back to the same MYT calendar day it was given', () => {
    for (const d of ['2026-01-01', '2026-07-28', '2026-12-31']) {
      const iso = mytMidnightIso(d);
      // +8h moves the instant back onto the MYT wall-clock day.
      expect(
        new Date(new Date(iso).getTime() + 8 * 3600_000)
          .toISOString()
          .slice(0, 10),
      ).toBe(d);
    }
  });
});

describe('mytToday', () => {
  test('rolls over at MYT midnight, not UTC midnight', () => {
    // 2026-07-27T16:00:00Z IS 2026-07-28 00:00 in Kuala Lumpur.
    expect(mytToday(new Date('2026-07-27T15:59:59.000Z'))).toBe('2026-07-27');
    expect(mytToday(new Date('2026-07-27T16:00:00.000Z'))).toBe('2026-07-28');
  });

  test('agrees with mytMidnightIso on the day it returns', () => {
    const now = new Date('2026-07-27T18:30:00.000Z');
    expect(mytMidnightIso(mytToday(now)).slice(0, 10)).toBe('2026-07-27');
  });
});
