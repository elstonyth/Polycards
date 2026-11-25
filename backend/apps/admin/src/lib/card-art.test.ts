import { describe, expect, it } from 'vitest';
import { artCodeFromFilename, pickCardArt, titleCardCode } from './card-art';

const row = (code: string) => ({ code, image_url: `https://cdn/${code}.webp` });

describe('artCodeFromFilename', () => {
  it('reads the printing code at the start of a file name', () => {
    expect(artCodeFromFilename('OP05-119.png')).toBe('OP05-119');
    expect(artCodeFromFilename('op05-119_P3.webp')).toBe('OP05-119_p3');
    expect(artCodeFromFilename('EB02-006_p2_JP.webp.png')).toBe('EB02-006_p2');
    expect(artCodeFromFilename('P-101_p3.png')).toBe('P-101_p3');
    expect(artCodeFromFilename('PRB01-001.webp')).toBe('PRB01-001');
  });
  it('null for names without a code at the start', () => {
    expect(artCodeFromFilename('luffy.png')).toBeNull();
    expect(artCodeFromFilename('scan OP05-119.png')).toBeNull();
    expect(artCodeFromFilename('OP05-1190.png')).toBeNull();
  });
});

describe('titleCardCode', () => {
  it('finds the code in a PriceCharting title, whatever is around it', () => {
    expect(titleCardCode('Monkey.D.Luffy [SP Gold] OP05-119')).toBe('OP05-119');
    expect(titleCardCode('Kid & Killer [Alternate Art] EB01-003')).toBe(
      'EB01-003',
    );
    expect(titleCardCode('Hi-Nu Gundam EX [Holo] #EB01-002')).toBe('EB01-002');
    expect(titleCardCode('Monkey.D.Luffy P-001')).toBe('P-001');
    expect(titleCardCode('Charizard #4')).toBeNull();
  });
});

describe('pickCardArt', () => {
  const family = [row('OP05-119'), row('OP05-119_p1'), row('OP05-119_p2')];
  it('a plain title takes the base printing', () => {
    expect(pickCardArt('Monkey.D.Luffy OP05-119', family).auto?.code).toBe(
      'OP05-119',
    );
  });
  it('a bracketed title with several alternate arts leaves the pick to the admin', () => {
    const r = pickCardArt('Monkey.D.Luffy [SP Gold] OP05-119', family);
    expect(r.auto).toBeNull();
    expect(r.choices.map((c) => c.code)).toEqual([
      'OP05-119',
      'OP05-119_p1',
      'OP05-119_p2',
    ]);
  });
  it('a bracketed title with exactly one alternate art takes it', () => {
    expect(
      pickCardArt('Izo [Alternate Art] EB01-002', [
        row('EB01-002'),
        row('EB01-002_p1'),
      ]).auto?.code,
    ).toBe('EB01-002_p1');
  });
  it('nothing uploaded for the card: no art', () => {
    expect(pickCardArt('Izo EB01-002', [])).toEqual({
      auto: null,
      choices: [],
    });
  });
  it('a plain title whose base printing is missing leaves the pick to the admin', () => {
    expect(pickCardArt('Izo EB01-002', [row('EB01-002_p1')]).auto).toBeNull();
  });
});
