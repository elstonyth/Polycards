import { describe, expect, test } from 'vitest';
import { snapshotOf, type BoxBufferState } from './box-snapshot';

const base: BoxBufferState = {
  name: 'Tier A',
  enabled: true,
  drawsPerDay: '1',
  rows: [
    {
      kind: 'credit',
      amountInput: '5',
      productHandle: null,
      qtyInput: '1',
      locked: false,
      pctInput: '0',
    },
  ],
};

describe('snapshotOf', () => {
  test('equal buffers produce equal snapshots regardless of localId', () => {
    const a = snapshotOf(base);
    const b = snapshotOf({ ...base, rows: base.rows.map((r) => ({ ...r })) });
    expect(a).toBe(b);
  });

  test('an edited amount changes the snapshot', () => {
    const edited = { ...base, rows: [{ ...base.rows[0], amountInput: '10' }] };
    expect(snapshotOf(edited)).not.toBe(snapshotOf(base));
  });

  test('toggling enabled changes the snapshot', () => {
    expect(snapshotOf({ ...base, enabled: false })).not.toBe(snapshotOf(base));
  });
});
