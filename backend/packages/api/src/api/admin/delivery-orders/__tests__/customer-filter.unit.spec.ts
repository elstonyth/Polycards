import { coerceCustomerId } from '../validate';

// ?customer_id= scopes the admin delivery table to one player. Unlike the
// sibling ?q=/?status= coercers, an EMPTY string is rejected rather than
// treated as absent: a player tab that silently falls back to every customer's
// orders is a leak, so the caller must send the param or omit it.
describe('coerceCustomerId', () => {
  it('passes undefined through (no filter)', () => {
    expect(coerceCustomerId(undefined)).toBeUndefined();
  });

  it('trims and returns a valid id', () => {
    expect(coerceCustomerId('  cus_1  ')).toBe('cus_1');
  });

  it('accepts a 64-char id', () => {
    const id = 'c'.repeat(64);
    expect(coerceCustomerId(id)).toBe(id);
  });

  it('rejects an empty / whitespace-only value', () => {
    expect(() => coerceCustomerId('')).toThrow(/customer_id/);
    expect(() => coerceCustomerId('   ')).toThrow(/customer_id/);
  });

  it('rejects an over-long id', () => {
    expect(() => coerceCustomerId('c'.repeat(65))).toThrow(/customer_id/);
  });

  it('rejects a repeated param (array) and other non-strings', () => {
    expect(() => coerceCustomerId(['cus_1', 'cus_2'])).toThrow(/customer_id/);
    expect(() => coerceCustomerId(42)).toThrow(/customer_id/);
  });
});
