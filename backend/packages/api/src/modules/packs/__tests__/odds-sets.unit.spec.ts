import { coerceOddsSet, weightForSet } from '../odds-sets';

describe('weightForSet', () => {
  it('falls back to set 1 when 2 and 3 are empty', () => {
    const o = { weight: 100 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(100);
    expect(weightForSet(o, 3)).toBe(100);
  });

  it('inherits set 3 from set 2 when only 2 is set', () => {
    const o = { weight: 100, weight_2: 200 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(200);
    expect(weightForSet(o, 3)).toBe(200);
  });

  it('uses every set verbatim when all three are set', () => {
    const o = { weight: 100, weight_2: 200, weight_3: 300 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(200);
    expect(weightForSet(o, 3)).toBe(300);
  });

  it('skips an empty set 2 without dragging set 3 down', () => {
    const o = { weight: 100, weight_3: 300 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(100);
    expect(weightForSet(o, 3)).toBe(300);
  });

  it('treats an explicit 0 as a real weight, not an empty set', () => {
    const o = { weight: 100, weight_2: 0 };
    expect(weightForSet(o, 2)).toBe(0);
    // set 3 inherits the explicit 0 from set 2 — never rolls back to set 1.
    expect(weightForSet(o, 3)).toBe(0);
    expect(weightForSet({ weight: 100, weight_3: 0 }, 3)).toBe(0);
  });

  it('treats null as empty (a cleared column, not a 0 weight)', () => {
    const o = { weight: 100, weight_2: null, weight_3: null };
    expect(weightForSet(o, 2)).toBe(100);
    expect(weightForSet(o, 3)).toBe(100);
  });
});

describe('coerceOddsSet', () => {
  it('accepts sets 2 and 3 as number or string', () => {
    expect(coerceOddsSet(2)).toBe(2);
    expect(coerceOddsSet('2')).toBe(2);
    expect(coerceOddsSet(3)).toBe(3);
    expect(coerceOddsSet('3')).toBe(3);
  });

  it('rolls anything else to set 1', () => {
    for (const v of [1, '1', 0, 4, 'x', null, undefined, {}]) {
      expect(coerceOddsSet(v)).toBe(1);
    }
  });
});
