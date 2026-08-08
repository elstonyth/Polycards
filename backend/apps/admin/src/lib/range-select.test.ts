import { describe, expect, it } from 'vitest';
import { applyRangeSelect } from './range-select';

const IDS = ['a', 'b', 'c', 'd', 'e'];

describe('applyRangeSelect', () => {
  it('plain click toggles one id on and off', () => {
    const on = applyRangeSelect(new Set(), IDS, null, 'c', false);
    expect([...on]).toEqual(['c']);
    const off = applyRangeSelect(on, IDS, 'c', 'c', false);
    expect(off.size).toBe(0);
  });

  it('shift-click checks the whole range in either direction', () => {
    const down = applyRangeSelect(new Set(['b']), IDS, 'b', 'd', true);
    expect([...down].sort()).toEqual(['b', 'c', 'd']);
    const up = applyRangeSelect(new Set(['d']), IDS, 'd', 'b', true);
    expect([...up].sort()).toEqual(['b', 'c', 'd']);
  });

  it('shift-click on a checked id unchecks the range', () => {
    const prev = new Set(['a', 'b', 'c', 'd']);
    const next = applyRangeSelect(prev, IDS, 'b', 'd', true);
    expect([...next]).toEqual(['a']);
  });

  it('keeps selections outside the range untouched', () => {
    const prev = new Set(['a', 'e']);
    const next = applyRangeSelect(prev, IDS, 'b', 'c', true);
    expect([...next].sort()).toEqual(['a', 'b', 'c', 'e']);
  });

  it('falls back to a plain toggle when the anchor left the list', () => {
    const next = applyRangeSelect(new Set(), IDS, 'gone', 'c', true);
    expect([...next]).toEqual(['c']);
  });

  it('falls back to a plain toggle without shift or anchor', () => {
    const noAnchor = applyRangeSelect(new Set(), IDS, null, 'b', true);
    expect([...noAnchor]).toEqual(['b']);
    const sameId = applyRangeSelect(new Set(['b']), IDS, 'b', 'b', true);
    expect(sameId.size).toBe(0);
  });
});
