import { normalizeCardArtCode, parseCardArtBody } from '../parse';

describe('normalizeCardArtCode', () => {
  it('accepts booster, starter, extra, premium and promo codes, with an alt-art suffix', () => {
    expect(normalizeCardArtCode('OP05-119')).toBe('OP05-119');
    expect(normalizeCardArtCode('op05-119_P3')).toBe('OP05-119_p3');
    expect(normalizeCardArtCode('ST01-001')).toBe('ST01-001');
    expect(normalizeCardArtCode('EB02-006_p2')).toBe('EB02-006_p2');
    expect(normalizeCardArtCode('PRB01-001_p10')).toBe('PRB01-001_p10');
    expect(normalizeCardArtCode('P-101_p3')).toBe('P-101_p3');
  });
  it('rejects anything else', () => {
    for (const bad of [
      '',
      'OP5-119',
      'OP05-1190',
      'OP05-119_x1',
      'OP05-119 ',
      'Pikachu',
      '../OP05-119',
    ])
      expect(normalizeCardArtCode(bad)).toBeNull();
  });
});

describe('parseCardArtBody', () => {
  const url =
    'https://polycards-media.sgp1.cdn.digitaloceanspaces.com/op05-119.webp';
  it('normalizes codes and keeps the last image when a code repeats', () => {
    expect(
      parseCardArtBody({
        items: [
          { code: 'op05-119', image_url: url },
          { code: 'OP05-119', image_url: url + '?2' },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [{ code: 'OP05-119', image_url: url + '?2' }],
    });
  });
  it('rejects a bad code, a non-http image, an empty or oversized batch', () => {
    expect(
      parseCardArtBody({ items: [{ code: 'nope', image_url: url }] }).ok,
    ).toBe(false);
    expect(
      parseCardArtBody({
        items: [{ code: 'OP05-119', image_url: 'javascript:alert(1)' }],
      }).ok,
    ).toBe(false);
    expect(
      parseCardArtBody({
        items: [{ code: 'OP05-119', image_url: '//evil.example/x.png' }],
      }).ok,
    ).toBe(false);
    expect(parseCardArtBody({ items: [] }).ok).toBe(false);
    expect(parseCardArtBody({}).ok).toBe(false);
    const many = Array.from({ length: 201 }, () => ({
      code: 'OP05-119',
      image_url: url,
    }));
    expect(parseCardArtBody({ items: many }).ok).toBe(false);
  });
});
