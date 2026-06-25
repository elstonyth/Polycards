import { describe, it, expect } from 'vitest';
import {
  mapPoolToRows,
  rowsToBody,
  rowProbabilities,
  rowError,
  type RewardEditRow,
} from './reward-pool-rows';

const row = (over: Partial<RewardEditRow>): RewardEditRow => ({
  localId: 'x',
  kind: 'nothing',
  product_handle: null,
  credit_amount: '',
  weight: '1',
  ...over,
});

describe('rowProbabilities', () => {
  it('splits weight proportionally and sums to 100', () => {
    const rows = [
      row({
        localId: 'a',
        kind: 'product',
        product_handle: 'celebi',
        weight: '10',
      }),
      row({ localId: 'b', kind: 'credit', credit_amount: '5', weight: '20' }),
      row({ localId: 'c', kind: 'nothing', weight: '70' }),
    ];
    const p = rowProbabilities(rows);
    expect(p.get('a')).toBeCloseTo(10);
    expect(p.get('b')).toBeCloseTo(20);
    expect(p.get('c')).toBeCloseTo(70);
    expect([...p.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(100);
  });

  it('returns 0 for every row when total weight is 0 (never NaN)', () => {
    const rows = [
      row({ localId: 'a', weight: '0' }),
      row({ localId: 'b', weight: '' }),
    ];
    const p = rowProbabilities(rows);
    expect(p.get('a')).toBe(0);
    expect(p.get('b')).toBe(0);
  });
});

describe('rowsToBody', () => {
  it('drops the inapplicable payout field per kind and coerces numbers', () => {
    const rows = [
      row({
        localId: 'a',
        kind: 'product',
        product_handle: 'celebi',
        credit_amount: '999',
        weight: '10',
      }),
      row({
        localId: 'b',
        kind: 'credit',
        product_handle: 'ignored',
        credit_amount: '5',
        weight: '20',
      }),
      row({
        localId: 'c',
        kind: 'nothing',
        product_handle: 'x',
        credit_amount: '9',
        weight: '70',
      }),
    ];
    expect(rowsToBody(rows, 3, true)).toEqual({
      draws_per_day: 3,
      pool_enabled: true,
      entries: [
        { kind: 'product', product_handle: 'celebi', weight: 10 },
        { kind: 'credit', credit_amount: 5, weight: 20 },
        { kind: 'nothing', weight: 70 },
      ],
    });
  });
});

describe('rowError', () => {
  it('flags a non-positive / non-integer weight', () => {
    expect(rowError(row({ weight: '0' }))).toMatch(/weight/i);
    expect(rowError(row({ weight: '1.5' }))).toMatch(/weight/i);
    expect(rowError(row({ weight: '-1' }))).toMatch(/weight/i);
  });
  it('flags a product row with no handle', () => {
    expect(
      rowError(row({ kind: 'product', product_handle: '', weight: '1' })),
    ).toMatch(/product/i);
  });
  it('flags a credit row with amount <= 0', () => {
    expect(
      rowError(row({ kind: 'credit', credit_amount: '0', weight: '1' })),
    ).toMatch(/credit/i);
    expect(
      rowError(row({ kind: 'credit', credit_amount: '', weight: '1' })),
    ).toMatch(/credit/i);
  });
  it('passes a valid credit row', () => {
    expect(
      rowError(row({ kind: 'credit', credit_amount: '5', weight: '1' })),
    ).toBeNull();
  });
  it('passes a valid product row', () => {
    expect(
      rowError(row({ kind: 'product', product_handle: 'celebi', weight: '1' })),
    ).toBeNull();
  });
});

describe('mapPoolToRows', () => {
  it('maps entries to editable string-numeric rows with a local id', () => {
    const rows = mapPoolToRows([
      {
        id: 'x',
        kind: 'credit',
        product_handle: null,
        credit_amount: 5,
        weight: 20,
      },
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'credit',
      product_handle: null,
      credit_amount: '5',
      weight: '20',
    });
    expect(rows[0].localId).toBeTruthy();
  });
});
