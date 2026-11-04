import { expect, it } from 'vitest';
import { CoinFlipFeedSchema } from '@/lib/coin-flip';

const row = (id: string, win_amount: number) => ({
  id,
  status: 'won',
  expires_at: '2026-11-04T00:00:00.000Z',
  settled_at: '2026-11-04T00:00:30.000Z',
  stake_amount: 10,
  win_amount,
  published_win_percent: 50,
  card: {
    pull_id: `p_${id}`,
    name: 'Abra',
    image: null,
    grader: null,
    grade: null,
  },
  cards: [
    {
      pull_id: `p_${id}`,
      name: 'Abra',
      image: null,
      grader: null,
      grade: null,
      stake_amount: 10,
    },
  ],
  tickets: 0,
  chosen_side: 'head',
  landed_side: 'head',
  who: 'Ash',
  seed: 3,
  avatar_url: null,
  frame_url: null,
});

it('drops a row that disagrees with itself and keeps the rest of the feed', () => {
  const feed = CoinFlipFeedSchema.parse({
    rounds: [row('good', 10), row('bad', 99), { id: 'junk' }],
  });
  expect(feed.rounds.map((r) => r.id)).toEqual(['good']);
  expect(feed.rounds[0]?.who).toBe('Ash');
});
