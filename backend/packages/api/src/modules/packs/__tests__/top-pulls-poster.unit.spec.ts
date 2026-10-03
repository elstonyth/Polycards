import sharp from 'sharp';
import { POSTER_H, POSTER_W } from '../brand-poster';
import { composeTopPullsPoster, topPullsPoster } from '../top-pulls-poster';

const PULLS = [
  {
    rank: 1,
    cardName: 'Latias & Latios GX #105',
    grade: 'PSA 10',
    valueMyr: 32349.24,
    player: 'AhBiiiii',
  },
  {
    rank: 2,
    cardName: 'Pikachu with Grey Felt Hat #85',
    grade: 'PSA 10',
    valueMyr: 12417.7,
    player: 'A_very_long_collector_name_here',
  },
  { rank: 3, cardName: 'Raw Card', grade: '', valueMyr: 47, player: 'Bee' },
];

describe('topPullsPoster', () => {
  it('ranks the pulls with their value and the public name', () => {
    const p = topPullsPoster({
      dayLabel: '3 OCT 2026',
      pulls: PULLS,
      siteHost: 'polycards.gg',
    });
    expect(p.eyebrow).toBe('TOP HITS · 3 OCT 2026');
    expect(p.valueLabel).toBeNull();
    expect(
      p.tiles.map((t) => [t.label, t.title, t.note, t.key, t.valueMyr]),
    ).toEqual([
      ['#1', 'Latias & Latios GX #105 · PSA 10', 'AhBiiiii', 1, 32349.24],
      [
        '#2',
        'Pikachu with Grey Felt Hat #85 · PSA 10',
        'A_very_long_collector_name_here',
        2,
        12417.7,
      ],
      ['#3', 'Raw Card', 'Bee', 3, 47],
    ]);
  });
});

describe('composeTopPullsPoster', () => {
  it('draws ten tiles at the feed size and names the missing art by rank', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      ...PULLS[i % 3],
      rank: i + 1,
    }));
    const { jpeg, placeholders } = await composeTopPullsPoster(
      { dayLabel: '3 OCT 2026', pulls: ten, siteHost: 'polycards.gg' },
      ten.map(() => null),
    );
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual([
      'jpeg',
      POSTER_W,
      POSTER_H,
    ]);
    expect(placeholders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
