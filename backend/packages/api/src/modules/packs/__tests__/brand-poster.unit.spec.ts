import sharp from 'sharp';
import {
  composeBrandPoster,
  POSTER_H,
  POSTER_W,
  posterFigure,
  posterRm,
  posterTextError,
} from '../brand-poster';

describe('posterFigure', () => {
  it('shows the live count exactly by default', () => {
    expect(posterFigure(480, 'exact')).toBe('480');
    expect(posterFigure(12345, 'exact')).toBe('12,345');
    expect(posterFigure(0, 'exact')).toBe('0');
  });

  it('rounds DOWN to the hundred, never up', () => {
    expect(posterFigure(480, 'hundred')).toBe('400+');
    expect(posterFigure(599, 'hundred')).toBe('500+');
    expect(posterFigure(600, 'hundred')).toBe('600+');
    expect(posterFigure(1234, 'hundred')).toBe('1,200+');
  });

  it('keeps a count under a hundred exact', () => {
    expect(posterFigure(99, 'hundred')).toBe('99');
  });
});

describe('posterRm', () => {
  it('prints a price like the storefront: RM with sen', () => {
    expect(posterRm(204223.74)).toBe('RM 204,223.74');
    expect(posterRm(5000)).toBe('RM 5,000.00');
  });
});

describe('posterTextError', () => {
  it('accepts English words and punctuation', () => {
    expect(posterTextError('Thank you, collectors!', 60)).toBeNull();
    expect(
      posterTextError("Ripping since day one — what's next?", 60),
    ).toBeNull();
  });

  it('refuses typed numbers: a figure comes from live data only', () => {
    expect(posterTextError('600+ registered players', 60)).toMatch(/metric/);
    expect(posterTextError('Top 10', 60)).toMatch(/metric/);
  });

  it('refuses text the brand fonts cannot draw', () => {
    expect(posterTextError('累计注册', 60)).toMatch(/English/);
    expect(posterTextError('Hello 🎉', 60)).toMatch(/English/);
  });

  it('refuses blank and over-long text', () => {
    expect(posterTextError('   ', 60)).toMatch(/empty/);
    expect(posterTextError('A'.repeat(61), 60)).toMatch(/60 characters/);
  });
});

describe('composeBrandPoster', () => {
  it('draws a 4:5 feed JPEG and names the slabs drawn as placeholders', async () => {
    const { jpeg, placeholders } = await composeBrandPoster(
      {
        kicker: 'Community milestone',
        headline: 'Collectors and counting.',
        stat: '400+',
        subline: 'Thank you for ripping with us.',
        cards: [
          { name: 'Card A', rarity: 'Immortal' },
          { name: 'Card B', rarity: 'Legendary' },
          { name: 'Card C', rarity: 'Rare' },
        ],
        chase: { priceMyr: 204223.74, name: 'Card A', pack: 'Diamond Pack' },
        siteHost: 'polycards.gg',
      },
      [null, Buffer.from('not an image'), null],
    );
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([POSTER_W, POSTER_H]);
    expect(placeholders).toEqual([1, 2, 3]);
  });

  it('lays out type only when there are no cards', async () => {
    const { jpeg, placeholders } = await composeBrandPoster(
      {
        kicker: '',
        headline: 'Something new is coming.',
        stat: null,
        subline: '',
        cards: [],
        chase: null,
        siteHost: 'polycards.gg',
      },
      [],
    );
    const meta = await sharp(jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([POSTER_W, POSTER_H]);
    expect(placeholders).toEqual([]);
  });
});
