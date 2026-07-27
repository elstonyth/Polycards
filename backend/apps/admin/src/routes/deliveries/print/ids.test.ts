import { describe, it, expect } from 'vitest';
import { parsePrintIds, PRINT_ID_CAP } from './ids';

describe('parsePrintIds', () => {
  it('splits the comma list in selection order', () => {
    expect(parsePrintIds('dord_a,dord_b,dord_c')).toEqual([
      'dord_a',
      'dord_b',
      'dord_c',
    ]);
  });

  it('returns [] for a missing or empty ids param', () => {
    expect(parsePrintIds(null)).toEqual([]);
    expect(parsePrintIds('')).toEqual([]);
    // A list of nothing but separators/whitespace is still nothing to print.
    expect(parsePrintIds(' , , ')).toEqual([]);
  });

  it('drops blanks from a trailing/doubled comma', () => {
    expect(parsePrintIds('dord_a,,dord_b,')).toEqual(['dord_a', 'dord_b']);
  });

  it('collapses duplicates so a block is never printed (or fetched) twice', () => {
    expect(parsePrintIds('dord_a,dord_b,dord_a')).toEqual([
      'dord_a',
      'dord_b',
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(parsePrintIds(' dord_a , dord_b ')).toEqual(['dord_a', 'dord_b']);
  });

  it('does not cap on its own — the page enforces PRINT_ID_CAP', () => {
    const many = Array.from({ length: PRINT_ID_CAP + 1 }, (_, i) => `id_${i}`);
    expect(parsePrintIds(many.join(','))).toHaveLength(PRINT_ID_CAP + 1);
  });
});
