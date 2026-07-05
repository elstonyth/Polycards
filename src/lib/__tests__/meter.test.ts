import { describe, expect, test } from 'vitest';
import { meterChars } from '@/lib/meter';

describe('meterChars', () => {
  test('flags digits and passes through separators', () => {
    expect(meterChars('RM 1,050.00')).toEqual([
      { char: 'R', digit: false },
      { char: 'M', digit: false },
      { char: ' ', digit: false },
      { char: '1', digit: true },
      { char: ',', digit: false },
      { char: '0', digit: true },
      { char: '5', digit: true },
      { char: '0', digit: true },
      { char: '.', digit: false },
      { char: '0', digit: true },
      { char: '0', digit: true },
    ]);
  });
  test('empty string → empty list', () => {
    expect(meterChars('')).toEqual([]);
  });
});
