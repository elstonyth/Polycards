import sharp from 'sharp';
import {
  type AchievementTile,
  composeAchievementsPoster,
  ladderSlots,
} from '../achievements-poster';
import { POSTER_H, POSTER_W } from '../brand-poster';

describe('ladderSlots', () => {
  it('climbs the left column first, then the right', () => {
    expect(ladderSlots(10)).toEqual([
      { col: 0, row: 0, cols: 2 },
      { col: 0, row: 1, cols: 2 },
      { col: 0, row: 2, cols: 2 },
      { col: 0, row: 3, cols: 2 },
      { col: 0, row: 4, cols: 2 },
      { col: 1, row: 0, cols: 2 },
      { col: 1, row: 1, cols: 2 },
      { col: 1, row: 2, cols: 2 },
      { col: 1, row: 3, cols: 2 },
      { col: 1, row: 4, cols: 2 },
    ]);
  });

  it('gives an odd count the extra tile on the left', () => {
    expect(ladderSlots(7).map((s) => [s.col, s.row])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
  });

  it('keeps five or fewer in one full-width column', () => {
    expect(ladderSlots(5)).toEqual(
      [0, 1, 2, 3, 4].map((row) => ({ col: 0, row, cols: 1 })),
    );
    expect(ladderSlots(1)).toEqual([{ col: 0, row: 0, cols: 1 }]);
  });
});

// The live ladder on 2026-10-03: a credit, four free rips and five PSA 10
// slabs, two of them named with '&' (which must reach the SVG escaped).
const LIVE: AchievementTile[] = [
  { level: 10, kind: 'credit', prize: 'RM 50.00 credit', valueMyr: 50 },
  { level: 20, kind: 'pack', prize: 'Free rip · Bronze Pack', valueMyr: 300 },
  { level: 30, kind: 'pack', prize: 'Free rip · Silver Pack', valueMyr: 600 },
  { level: 40, kind: 'pack', prize: 'Free rip · Gold Pack', valueMyr: 1200 },
  {
    level: 50,
    kind: 'pack',
    prize: 'Free rip · Platinum Pack',
    valueMyr: 2500,
  },
  {
    level: 60,
    kind: 'card',
    prize: "Pikachu with Grey Felt Hat #85 · PSA 10",
    valueMyr: 12768.84,
  },
  {
    level: 70,
    kind: 'card',
    prize: 'Magikarp & Wailord GX #99 · PSA 10',
    valueMyr: 9576,
  },
  {
    level: 80,
    kind: 'card',
    prize: "'s Pikachu #7 · PSA 10",
    valueMyr: 20160,
  },
  {
    level: 90,
    kind: 'card',
    prize: 'Latias & Latios GX #105 · PSA 10',
    valueMyr: 33264,
  },
  {
    level: 100,
    kind: 'card',
    prize: 'Pikachu #288/SM-P · PSA 10',
    valueMyr: 75600,
  },
];

describe('composeAchievementsPoster', () => {
  it('draws the live ten-level ladder at the feed size', async () => {
    const { jpeg, placeholders } = await composeAchievementsPoster(
      { tiles: LIVE, siteHost: 'polycards.gg/task' },
      LIVE.map(() => null),
    );
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([POSTER_W, POSTER_H]);
    // Every prize with a picture is missing here; the credit has none to
    // miss, so it is never reported.
    expect(placeholders).toEqual([20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('places real art and reports nothing missing', async () => {
    const art = await sharp({
      create: {
        width: 60,
        height: 100,
        channels: 4,
        background: { r: 200, g: 40, b: 40, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const tiles = LIVE.slice(0, 3);
    const { jpeg, placeholders } = await composeAchievementsPoster(
      { tiles, siteHost: 'polycards.gg/task' },
      [null, art, art],
    );
    expect(placeholders).toEqual([]);
    expect((await sharp(jpeg).metadata()).height).toBe(POSTER_H);
  });

  it('survives art that does not decode', async () => {
    const { placeholders } = await composeAchievementsPoster(
      { tiles: LIVE.slice(1, 2), siteHost: 'polycards.gg/task' },
      [Buffer.from('not an image')],
    );
    expect(placeholders).toEqual([20]);
  });
});
