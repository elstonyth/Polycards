import { describe, expect, it } from 'vitest';
import {
  LOGO_LETTERS,
  LOGO_MARK,
  LOGO_MARK_STROKE,
  LOGO_VIEWBOX,
} from '../polycards-logo-paths';

const VIEW_W = 360;
const VIEW_H = 97;

/** Absolute x and y values of a path that uses only M, L, H, V, C and Z. */
function coords(d: string) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, cmd, args] of d.matchAll(/([MLHVCZ])([^MLHVCZ]*)/g)) {
    const n = ((args ?? '').match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (cmd === 'H') xs.push(...n);
    else if (cmd === 'V') ys.push(...n);
    else n.forEach((v, i) => (i % 2 === 0 ? xs : ys).push(v));
  }
  return { xs, ys };
}

describe('polycards logo paths', () => {
  it('keeps the PNG box', () => {
    expect(LOGO_VIEWBOX).toBe('0 0 360 97');
  });

  it('spells Polycards with one path per letter', () => {
    expect(LOGO_LETTERS).toHaveLength(9);
    expect(LOGO_LETTERS.map((l) => l.char).join('')).toBe('Polycards');
  });

  it('runs left to right inside the viewBox', () => {
    let prev: (typeof LOGO_LETTERS)[number] | undefined;
    for (const letter of LOGO_LETTERS) {
      expect(letter.x0).toBeGreaterThanOrEqual(0);
      expect(letter.x1).toBeLessThanOrEqual(VIEW_W);
      expect(letter.x1).toBeGreaterThan(letter.x0);
      if (prev) {
        // y and c touch, so extents may overlap; their order may not
        expect(letter.x0).toBeGreaterThan(prev.x0);
        expect(letter.x1).toBeGreaterThan(prev.x1);
      }
      prev = letter;
    }
  });

  it('has non-empty closed letter paths whose points sit inside the viewBox', () => {
    for (const letter of LOGO_LETTERS) {
      expect(letter.d).toMatch(/^M[^MLHVCZ]+[LHVC]/);
      expect(letter.d).toMatch(/Z$/);
      expect(letter.d).toMatch(/^[MLHVCZ\d.\s-]+$/);
      const { xs, ys } = coords(letter.d);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(VIEW_W);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(VIEW_H);
    }
  });

  it('draws the mark left of the wordmark with a positive stroke', () => {
    expect(LOGO_MARK).toMatch(/^M/);
    expect(LOGO_MARK).toMatch(/^[MLHVCZ\d.\s-]+$/);
    const { xs, ys } = coords(LOGO_MARK);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(
      Math.min(...LOGO_LETTERS.map((l) => l.x0)),
    );
    expect(LOGO_MARK_STROKE.width).toBeGreaterThan(0);
  });
});
