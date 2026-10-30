import { toProcure } from '../stock-math';

describe('toProcure (spec 2026-10-28: positive "need N")', () => {
  it('is the shortfall of on hand against every open order unit', () => {
    expect(toProcure(0, 3, 0)).toBe(3);
    expect(toProcure(2, 3, 1)).toBe(2);
  });

  it('is 0 when on hand covers requested + ready to ship', () => {
    expect(toProcure(5, 3, 1)).toBe(0);
    expect(toProcure(4, 3, 1)).toBe(0);
  });

  it('treats negative on hand (bad history) as a deeper shortfall', () => {
    expect(toProcure(-1, 1, 0)).toBe(2);
  });
});
