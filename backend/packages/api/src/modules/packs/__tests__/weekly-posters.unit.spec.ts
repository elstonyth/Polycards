import sharp from 'sharp';
import { POSTER_H, POSTER_W } from '../brand-poster';
import {
  cardWidth,
  composeResultsPoster,
  MAX_ROW_CARDS,
  resultsHeadline,
  rmWhole,
} from '../challenge-results-poster';
import { fitToFeed } from '../feed-size';
import {
  composeStagesPoster,
  restLine,
  stageBlock,
  stagesHeadline,
} from '../challenge-stages-poster';
import {
  composeTasksPoster,
  splitWeeklyTasks,
  taskWeekLabel,
} from '../tasks-poster';

const jpegSize = async (jpeg: Buffer) => {
  const meta = await sharp(jpeg).metadata();
  return { format: meta.format, width: meta.width, height: meta.height };
};

describe('results poster', () => {
  it('words the pool and the stages it unlocked', () => {
    expect(rmWhole(2317411.23)).toBe('RM 2,317,411');
    expect(resultsHeadline(2317411.23, [1, 2, 3])).toBe(
      'RM 2,317,411 POOLED · 3 STAGES UNLOCKED',
    );
    expect(resultsHeadline(150000, [1])).toBe(
      'RM 150,000 POOLED · 1 STAGE UNLOCKED',
    );
    expect(resultsHeadline(null, [])).toBe('NO STAGE UNLOCKED');
  });

  it('draws the top 3 and the ledger as two feed-size images, naming the ranks without art', async () => {
    const input = {
      weekLabel: '28 SEPT – 4 OCT',
      headline: 'RM 2,317,411 POOLED · 3 STAGES UNLOCKED',
      podium: [
        {
          rank: 1,
          name: 'AhBiiiii',
          pulledMyr: 452123.4,
          prizeMyr: 12400,
          credits: 0,
          cards: ['Gengar VMAX #271', 'Mew ex #232', 'Mew ex #232'],
        },
        {
          rank: 2,
          name: 'coco',
          pulledMyr: 301000,
          prizeMyr: 9000,
          credits: 0,
          cards: ['Charizard GX #SV49'],
        },
        // Credits only: a money tile, never a missing-art placeholder.
        {
          rank: 3,
          name: 'squirtle',
          pulledMyr: 250000,
          prizeMyr: 2500,
          credits: 2500,
          cards: [],
        },
      ],
      list: Array.from({ length: 7 }, (_, i) => ({
        rank: i + 4,
        name: `player_${i + 4}`,
        pulledMyr: 100000 - i * 9000,
        prizeMyr: 2000 - i * 250,
      })),
      siteHost: 'polycards.gg/leaderboard',
    };
    const top = await composeResultsPoster(input, new Map(), 'top');
    expect(await jpegSize(top.jpeg)).toEqual({
      format: 'jpeg',
      width: POSTER_W,
      height: POSTER_H,
    });
    expect(top.placeholders).toEqual([1, 2]);
    const rest = await composeResultsPoster(input, new Map(), 'rest');
    expect(await jpegSize(rest.jpeg)).toEqual({
      format: 'jpeg',
      width: POSTER_W,
      height: POSTER_H,
    });
    expect(rest.placeholders).toEqual([]);
  });

  it('sizes a row of cards to the room, never past its cap', () => {
    // Three cards fit at full size; five shrink to share the room.
    expect(cardWidth(3, 584, 170, 16)).toBe(170);
    expect(cardWidth(3, 420, 140, 12)).toBe(132);
    expect(cardWidth(5, 584, 170, 16)).toBe(Math.floor((584 - 4 * 16) / 5));
    expect(cardWidth(0, 584, 170, 16)).toBe(0);
    expect(MAX_ROW_CARDS).toBe(5);
  });

  it('draws every card from real art side by side, counting the ones past the fifth', async () => {
    const slab = await sharp({
      create: { width: 160, height: 259, channels: 4, background: '#3366ff' },
    })
      .png()
      .toBuffer();
    const seven = Array.from({ length: 7 }, (_, i) => `Card ${i + 1}`);
    const { jpeg, placeholders } = await composeResultsPoster(
      {
        weekLabel: '28 SEPT – 4 OCT',
        headline: 'RM 1 POOLED · 1 STAGE UNLOCKED',
        podium: [
          {
            rank: 1,
            name: 'A',
            pulledMyr: 1,
            prizeMyr: 1,
            credits: 0,
            cards: seven,
          },
        ],
        list: [],
        siteHost: 'polycards.gg/leaderboard',
      },
      new Map([[1, seven.map(() => slab)]]),
    );
    expect(await jpegSize(jpeg)).toEqual({
      format: 'jpeg',
      width: POSTER_W,
      height: POSTER_H,
    });
    expect(placeholders).toEqual([]);
  });
});

describe('fitToFeed', () => {
  it('fits a tall poster whole onto 1080x1350 and leaves one that size alone', async () => {
    const tall = await sharp({
      create: { width: 1080, height: 2000, channels: 3, background: '#ffb020' },
    })
      .jpeg()
      .toBuffer();
    expect(await jpegSize(await fitToFeed(tall))).toEqual({
      format: 'jpeg',
      width: POSTER_W,
      height: POSTER_H,
    });
    const exact = await sharp({
      create: {
        width: POSTER_W,
        height: POSTER_H,
        channels: 3,
        background: '#0a0a0a',
      },
    })
      .jpeg()
      .toBuffer();
    expect(await fitToFeed(exact)).toBe(exact);
  });
});

describe('stages poster', () => {
  const stage = {
    stageNumber: 1,
    thresholdMyr: 300000,
    rankRewards: [
      { rank: 1, cardId: 'mewtwo', credits: 0 },
      { rank: 2, cardId: 'sylveon', credits: 0 },
      { rank: 3, cardId: null, credits: 600 },
      { rank: 4, cardId: null, credits: 1800 },
      { rank: 5, cardId: null, credits: 800 },
      { rank: 10, cardId: null, credits: 80 },
    ],
  };
  const cards = {
    mewtwo: { name: 'Mewtwo #3' },
    sylveon: { name: 'Sylveon VMAX #93' },
  };

  it('splits a stage into its podium and what ranks 4-10 win', () => {
    expect(stageBlock(stage, cards, false)).toEqual({
      stage: 1,
      thresholdMyr: 300000,
      unlocked: false,
      podium: [
        { rank: 1, name: 'Mewtwo #3', credits: 0 },
        { rank: 2, name: 'Sylveon VMAX #93', credits: 0 },
        { rank: 3, name: null, credits: 600 },
      ],
      rest: { from: 4, to: 10, minCredits: 80, maxCredits: 1800, cards: 0 },
    });
  });

  it('words the rest line', () => {
    expect(
      restLine({ from: 4, to: 10, minCredits: 80, maxCredits: 1800, cards: 0 }),
    ).toBe('#4–#10 · RM 1,800 – RM 80 CREDITS');
    expect(
      restLine({ from: 4, to: 4, minCredits: 500, maxCredits: 500, cards: 1 }),
    ).toBe('#4 · RM 500 CREDITS + 1 CARD');
    expect(stagesHeadline(4)).toBe('4 STAGES · EVERY REWARD STACKS');
    expect(stagesHeadline(1)).toBe('1 STAGE OF PRIZES');
  });

  it('draws every stage, three of them with an odd one centred', async () => {
    const blocks = [1, 2, 3].map((n) =>
      stageBlock(
        { ...stage, stageNumber: n, thresholdMyr: n * 300000 },
        cards,
        n === 1,
      ),
    );
    const { jpeg, placeholders } = await composeStagesPoster(
      {
        weekLabel: '5 OCT – 11 OCT',
        headline: stagesHeadline(3),
        stages: blocks,
        siteHost: 'polycards.gg/leaderboard',
      },
      new Map(),
    );
    expect(await jpegSize(jpeg)).toEqual({
      format: 'jpeg',
      width: POSTER_W,
      height: POSTER_H,
    });
    expect(placeholders).toEqual(['1:1', '1:2', '2:1', '2:2', '3:1', '3:2']);
  });
});

describe('tasks poster', () => {
  const task = (
    title: string,
    requirement: string,
    checkin: number | null,
    prize: string,
    type: 'credit' | 'pack' | 'card',
    value: number | null,
  ) => ({
    title,
    requirement,
    checkin_days: checkin,
    prize,
    prize_type: type,
    value_myr: value,
    image: null,
  });
  const weekly = [
    task(
      'Check in 5 days',
      'Check in on 5 days this week',
      5,
      'Free rip · 30th Celebration',
      'pack',
      45,
    ),
    task(
      'Rip 10 Bronze',
      'Rip 10 × Bronze Pack this week',
      null,
      'Free rip · Bronze Pack',
      'pack',
      300,
    ),
    task(
      'Check in 1 day',
      'Check in on 1 day this week',
      1,
      'Pikachu #29 · PSA 10',
      'card',
      120.5,
    ),
    task(
      'Check in 3 days',
      'Check in on 3 days this week',
      3,
      'RM 15.00 credit',
      'credit',
      15,
    ),
    task(
      'Rip Silver',
      'Rip 1 × Silver Pack this week',
      null,
      'Free rip · 30th Celebration',
      'pack',
      45,
    ),
  ];

  it('groups the check-in tiers by days and keeps the rest as tiles', () => {
    const { checkins, tasks } = splitWeeklyTasks(weekly);
    expect(checkins.map((c) => [c.days, c.prize, c.kind, c.valueMyr])).toEqual([
      [1, 'Pikachu #29 · PSA 10', 'card', 120.5],
      [3, 'RM 15.00 credit', 'credit', 15],
      [5, 'Free rip · 30th Celebration', 'pack', 45],
    ]);
    expect(tasks.map((t) => [t.requirement, t.prize, t.valueMyr])).toEqual([
      ['Rip 10 × Bronze Pack', 'Free rip · Bronze Pack', 300],
      ['Rip 1 × Silver Pack', 'Free rip · 30th Celebration', 45],
    ]);
  });

  it('labels the Monday-to-Sunday week', () => {
    expect(taskWeekLabel('2026-10-05')).toBe('5 OCT – 11 OCT');
    expect(taskWeekLabel('2026-09-28')).toBe('28 SEPT – 4 OCT');
  });

  it('draws at the feed size and drops the tiles that do not fit', async () => {
    const { checkins, tasks } = splitWeeklyTasks(weekly);
    const many = [...tasks, ...tasks, ...tasks];
    const { jpeg, placeholders, dropped } = await composeTasksPoster(
      {
        weekLabel: '5 OCT – 11 OCT',
        checkins,
        tasks: many,
        siteHost: 'polycards.gg/task',
      },
      { checkins: checkins.map(() => null), tasks: many.map(() => null) },
    );
    expect(await jpegSize(jpeg)).toEqual({
      format: 'jpeg',
      width: POSTER_W,
      height: POSTER_H,
    });
    // The credit tier is a wallet tile, not a missing picture.
    expect(placeholders.filter((p) => p.startsWith('checkin'))).toEqual([
      'checkin:1',
      'checkin:5',
    ]);
    expect(dropped).toBeGreaterThan(0);
    expect(placeholders.filter((p) => p.startsWith('task')).length).toBe(
      many.length - dropped,
    );
  });
});
