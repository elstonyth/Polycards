import { coerceCreatePurchaseInvoiceBody } from '../validate';

const okBody = () => ({
  date: '2026-07-28T00:00:00.000Z',
  supplier: 'Acme Cards Sdn Bhd',
  reverses_invoice_id: null,
  lines: [
    {
      card_handle: 'charizard-psa-10',
      card_name: 'Charizard PSA 10',
      fmv_snapshot: 300,
      qty: 10,
      unit_cost: 150,
    },
  ],
});

describe('coerceCreatePurchaseInvoiceBody', () => {
  it('accepts a valid body', () => {
    const b = coerceCreatePurchaseInvoiceBody(okBody());
    expect(b.lines).toHaveLength(1);
    expect(b.supplier).toBe('Acme Cards Sdn Bhd');
  });

  it('trims supplier and line card_name/card_handle', () => {
    const raw = okBody();
    raw.supplier = '  Acme Cards Sdn Bhd  ';
    raw.lines[0].card_handle = ' charizard-psa-10 ';
    const b = coerceCreatePurchaseInvoiceBody(raw);
    expect(b.supplier).toBe('Acme Cards Sdn Bhd');
    expect(b.lines[0].card_handle).toBe('charizard-psa-10');
  });

  it.each([
    [{ ...okBody(), date: 'not-a-date' }],
    [{ ...okBody(), supplier: '' }],
    [{ ...okBody(), lines: [] }],
    [
      {
        ...okBody(),
        lines: Array.from({ length: 201 }, () => okBody().lines[0]),
      },
    ],
    [{ ...okBody(), lines: [{ ...okBody().lines[0], qty: 0 }] }],
    [{ ...okBody(), lines: [{ ...okBody().lines[0], qty: 1.5 }] }],
    [{ ...okBody(), lines: [{ ...okBody().lines[0], unit_cost: -1 }] }],
    [{ ...okBody(), lines: [{ ...okBody().lines[0], fmv_snapshot: -1 }] }],
    [{ ...okBody(), lines: [{ ...okBody().lines[0], card_handle: '' }] }],
  ])('rejects %j', (body) => {
    expect(() => coerceCreatePurchaseInvoiceBody(body)).toThrow();
  });

  it('a reversing invoice (reverses_invoice_id set) rejects a non-negative line', () => {
    const b = { ...okBody(), reverses_invoice_id: 'pinv_1' };
    expect(() => coerceCreatePurchaseInvoiceBody(b)).toThrow(/negative-qty/i);
  });

  it('a non-reversing invoice rejects a negative-qty line', () => {
    const b = okBody();
    b.lines[0].qty = -10;
    expect(() => coerceCreatePurchaseInvoiceBody(b)).toThrow(
      /reverses_invoice_id/i,
    );
  });

  it('a reversing invoice with all-negative lines passes coercion (cross-invoice matching happens in the route)', () => {
    const b = {
      ...okBody(),
      reverses_invoice_id: 'pinv_1',
      lines: [{ ...okBody().lines[0], qty: -10 }],
    };
    expect(() => coerceCreatePurchaseInvoiceBody(b)).not.toThrow();
  });

  // Money is 2dp everywhere in this system (money.ts toSen/fromSen), and both
  // admin-UI prefill sources are already rounded to sen (displayMarketPrice).
  // A sub-sen unit_cost is therefore never a legitimate operator entry, and
  // rejecting it here is what makes the D8 weighted average exact rather than
  // merely well-approximated.
  it.each([
    ['unit_cost', 1.005],
    ['unit_cost', 0.001],
    ['fmv_snapshot', 12.3456],
  ])('rejects a sub-sen %s (%p)', (field, value) => {
    const b = {
      ...okBody(),
      lines: [{ ...okBody().lines[0], [field]: value }],
    };
    expect(() => coerceCreatePurchaseInvoiceBody(b)).toThrow(/at most 2/i);
  });

  // 0.1 + 0.2 is 0.30000000000000004 — a legitimate 2dp amount that an exact
  // integer-sen comparison would reject, hence the 1e-6 epsilon. It is also
  // normalized back onto the nearest 2dp double on the way out, so the float
  // junk never reaches line_total or the reversal match.
  it.each([
    [0, 0],
    [0.07, 0.07],
    [10.1, 10.1],
    [0.1 + 0.2, 0.3],
  ])('accepts the 2dp money value %p and normalizes it', (raw, expected) => {
    const b = {
      ...okBody(),
      lines: [{ ...okBody().lines[0], unit_cost: raw }],
    };
    expect(coerceCreatePurchaseInvoiceBody(b).lines[0].unit_cost).toBe(expected);
  });

  // Magnitude caps keep qty inside a Postgres `integer` column and keep the
  // float product qty*unit_cost orders of magnitude inside the line_total
  // CHECK's half-sen tolerance — a 400 here instead of a 500 from the DB.
  it.each([
    [{ ...okBody(), lines: [{ ...okBody().lines[0], qty: 1_000_001 }] }],
    [{ ...okBody(), lines: [{ ...okBody().lines[0], unit_cost: 1_000_001 }] }],
    [
      {
        ...okBody(),
        lines: [{ ...okBody().lines[0], fmv_snapshot: 1_000_001 }],
      },
    ],
  ])('rejects the out-of-range line %j', (body) => {
    expect(() => coerceCreatePurchaseInvoiceBody(body)).toThrow(/too large/i);
  });
});
