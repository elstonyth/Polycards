import { describe, expect, it } from 'vitest';
import { bentoLayout } from '@/lib/catalog-bento';

const cols = (n: number) => bentoLayout(n).map((c) => c.col);

/** Columns the cells cover on the 12-column grid; a tall cell covers two rows. */
const area = (n: number) =>
  bentoLayout(n).reduce((sum, c) => sum + c.col * (c.tall ? 2 : 1), 0);

describe('bentoLayout', () => {
  it('gives a lone pack the whole row', () => {
    expect(cols(1)).toEqual([12]);
  });

  it('splits two packs unevenly, the first one wider', () => {
    expect(cols(2)).toEqual([7, 5]);
  });

  it('puts three packs on one row with the first one double width', () => {
    expect(cols(3)).toEqual([6, 3, 3]);
    expect(bentoLayout(3)[0]?.tall).toBe(false);
  });

  it('stands the first pack two rows tall from four packs up', () => {
    expect(bentoLayout(4)[0]).toEqual({ col: 6, tall: true });
    expect(bentoLayout(5)[0]).toEqual({ col: 6, tall: true });
  });

  it('fills the two rows beside a tall lead: four packs', () => {
    // Row 1: lead + 3 + 3. Row 2: lead + one pack across the rest.
    expect(cols(4)).toEqual([6, 3, 3, 6]);
  });

  it('fills the two rows beside a tall lead: five packs', () => {
    expect(cols(5)).toEqual([6, 3, 3, 3, 3]);
  });

  it('shares a last row evenly instead of leaving a hole', () => {
    expect(cols(6).slice(5)).toEqual([12]);
    expect(cols(7).slice(5)).toEqual([6, 6]);
    expect(cols(8).slice(5)).toEqual([4, 4, 4]);
    expect(cols(9).slice(5)).toEqual([3, 3, 3, 3]);
    // Thirteen: a full row of four, then a row of four.
    expect(cols(13).slice(5)).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    // Ten: a full row of four, then one pack across.
    expect(cols(10).slice(5)).toEqual([3, 3, 3, 3, 12]);
  });

  it('only the first pack is ever tall', () => {
    for (const n of [4, 5, 8, 13])
      expect(
        bentoLayout(n)
          .slice(1)
          .some((c) => c.tall),
      ).toBe(false);
  });

  it('always tiles whole rows of twelve, with one cell per pack', () => {
    for (let n = 1; n <= 24; n++) {
      expect(bentoLayout(n)).toHaveLength(n);
      expect(area(n) % 12).toBe(0);
    }
  });

  it('is empty for no packs', () => {
    expect(bentoLayout(0)).toEqual([]);
  });
});
