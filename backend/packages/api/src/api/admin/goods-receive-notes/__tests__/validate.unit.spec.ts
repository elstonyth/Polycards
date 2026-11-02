import { coerceCreateGoodsReceiveNoteBody } from '../validate';

const line = (over: Record<string, unknown> = {}) => ({
  card_handle: 'pika-psa10',
  card_name: 'Pikachu PSA 10',
  fmv_snapshot: 120.5,
  qty: 2,
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-28T00:00:00.000Z',
  supplier: '  Card Shop KL ',
  lines: [line()],
  ...over,
});

describe('coerceCreateGoodsReceiveNoteBody', () => {
  it('accepts a normal receipt and trims text', () => {
    expect(coerceCreateGoodsReceiveNoteBody(body())).toEqual({
      date: '2026-10-28T00:00:00.000Z',
      supplier: 'Card Shop KL',
      lines: [line()],
    });
  });

  it.each([
    [
      'qty 0',
      { lines: [line({ qty: 0 })] },
      /qty must be a whole number above 0/,
    ],
    [
      'negative qty',
      { lines: [line({ qty: -1 })] },
      /qty must be a whole number above 0/,
    ],
    [
      'fractional qty',
      { lines: [line({ qty: 1.5 })] },
      /qty must be a whole number above 0/,
    ],
    [
      'negative fmv',
      { lines: [line({ fmv_snapshot: -1 })] },
      /fmv_snapshot must be a number >= 0/,
    ],
    [
      '3dp fmv',
      { lines: [line({ fmv_snapshot: 1.005 })] },
      /at most 2 decimals/,
    ],
    ['empty supplier', { supplier: '   ' }, /'supplier' is required/],
    ['bad date', { date: 'yesterday' }, /'date' must be a valid date string/],
    ['no lines', { lines: [] }, /'lines' must be a non-empty array/],
    [
      'missing handle',
      { lines: [line({ card_handle: '' })] },
      /card_handle is required/,
    ],
  ])('rejects %s', (_label, over, message) => {
    expect(() => coerceCreateGoodsReceiveNoteBody(body(over))).toThrow(message);
  });
});
