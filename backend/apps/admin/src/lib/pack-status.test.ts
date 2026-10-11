import { describe, expect, it } from 'vitest';
import { packStatusOf, packStatusWrite, type PackStatus } from './pack-status';

describe('pack status', () => {
  it('reads sold out only from an active pack with in_stock false', () => {
    expect(packStatusOf({ status: 'active', in_stock: true })).toBe('active');
    expect(packStatusOf({ status: 'active', in_stock: false })).toBe(
      'sold_out',
    );
    expect(packStatusOf({ status: 'draft', in_stock: false })).toBe('draft');
    expect(packStatusOf({ status: 'active' })).toBe('active');
  });

  it('round-trips every status, and Draft resets in_stock', () => {
    for (const s of ['active', 'draft', 'sold_out'] as PackStatus[]) {
      expect(packStatusOf(packStatusWrite(s))).toBe(s);
    }
    expect(packStatusWrite('draft')).toEqual({
      status: 'draft',
      in_stock: true,
    });
  });
});
