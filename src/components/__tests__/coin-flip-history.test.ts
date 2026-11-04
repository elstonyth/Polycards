// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
const read = vi.hoisted(() => vi.fn());
const everyone = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions/coin-flip', () => ({
  getCoinFlipHistory: read,
  getCoinFlipFeed: everyone,
}));
vi.mock('next/image', () => ({
  default: ({ src }: { src: string }) => createElement('img', { src }),
}));
import { CoinFlipHistory } from '@/components/coin-flip/CoinFlipHistory';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  read.mockReset();
  everyone.mockReset();
  read.mockResolvedValue({
    ok: true,
    rounds: [],
    count: 11,
    totals: { head: 0, tail: 0 },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function render(paused: boolean) {
  await act(async () =>
    root.render(createElement(CoinFlipHistory, { paused })),
  );
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
it('does not request history when mounted during a toss', async () => {
  await render(true);
  expect(read).not.toHaveBeenCalled();
  await render(false);
  expect(read).toHaveBeenCalledExactlyOnceWith(1, 'all');
});
it('discards in-flight history and locks pagination until the toss is revealed', async () => {
  await render(false);
  let resolve!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => button('Next').click());
  expect(read).toHaveBeenLastCalledWith(2, 'all');
  await render(true);
  expect(button('Previous').disabled).toBe(true);
  expect(button('Next').disabled).toBe(true);
  expect(button('Won').disabled).toBe(true);
  await act(async () => resolve({ ok: false }));
  expect(host.querySelector('[role=alert]')).toBeNull();
  await render(false);
  expect(read).toHaveBeenCalledTimes(3);
  expect(button('Previous').disabled).toBe(false);
  expect(button('Won').disabled).toBe(false);
});

const card = (id: string, name: string, stake: number) => ({
  pull_id: id,
  name,
  image: `/cdn/${id}.webp`,
  grader: 'PSA',
  grade: '10',
  stake_amount: stake,
});
const flip = (status: 'won' | 'lost', cards: ReturnType<typeof card>[]) => {
  const stake = cards.reduce((sum, c) => sum + c.stake_amount, 0);
  return {
    id: `round_${status}`,
    status,
    expires_at: '2026-10-30T07:00:00.000Z',
    settled_at: '2026-10-30T07:52:16.000Z',
    stake_amount: stake,
    win_amount: status === 'won' ? stake : 0,
    published_win_percent: 50,
    card: cards[0],
    cards,
    chosen_side: 'tail',
    landed_side: status === 'won' ? 'tail' : 'head',
  };
};
const row = (id: string) =>
  host.querySelector<HTMLAnchorElement>(`a[href$="round=${id}"]`)!;

it('opens a row in place, and not at all while a toss is in the air', async () => {
  const one = {
    ...flip('won', []),
    id: 'opened',
    card: null,
    stake_amount: 0,
    win_amount: 0,
    tickets: 5,
  };
  read.mockResolvedValue({
    ok: true,
    rounds: [one],
    count: 1,
    totals: { head: 0, tail: 1 },
  });
  const onOpen = vi.fn();
  const show = (paused: boolean) =>
    act(async () =>
      root.render(createElement(CoinFlipHistory, { paused, onOpen })),
    );
  await show(false);
  expect(row('opened').getAttribute('aria-disabled')).toBeNull();
  await act(async () => row('opened').click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('opened');
  onOpen.mockClear();
  await show(true);
  expect(row('opened').getAttribute('aria-disabled')).toBe('true');
  expect(row('opened').tabIndex).toBe(-1);
  await act(async () => row('opened').click());
  expect(onOpen).not.toHaveBeenCalled();
});

it('shows a ticket flip as tickets, with no RM and no card', async () => {
  const tickets = (status: 'won' | 'lost') => ({
    ...flip(status, []),
    id: `tickets_${status}`,
    card: null,
    stake_amount: 0,
    win_amount: 0,
    tickets: 5,
  });
  read.mockResolvedValue({
    ok: true,
    rounds: [tickets('won'), tickets('lost')],
    count: 2,
    totals: { head: 1, tail: 1 },
  });
  await render(false);
  const won = row('tickets_won');
  expect(won.textContent).toContain('Called Tail');
  expect(won.textContent).toContain('Lucky Draw tickets');
  expect(won.textContent).toContain('+5');
  expect(won.textContent).not.toContain('5 tickets');
  expect(won.textContent).toContain('×5');
  expect(won.textContent).not.toContain('RM');
  expect(won.getAttribute('aria-label')).toBe(
    'Called Tail, won 5 tickets, 30 Oct, 03:52:16 PM',
  );
  const lost = row('tickets_lost');
  expect(lost.textContent).not.toContain('+5');
  expect(lost.getAttribute('aria-label')).toContain('lost, 5 tickets gone');
});

it('shows cards and tickets together when a flip staked both', async () => {
  const both = (status: 'won' | 'lost') => ({
    ...flip(status, [card('a', 'Abra', 100)]),
    id: `both_${status}`,
    tickets: 5,
  });
  read.mockResolvedValue({
    ok: true,
    rounds: [both('won'), both('lost')],
    count: 2,
    totals: { head: 1, tail: 1 },
  });
  await render(false);
  const won = row('both_won');
  expect(won.textContent).toContain('Abra');
  expect(won.textContent).toContain('+RM 100.00');
  expect(won.textContent).toContain('+× 5');
  expect(won.getAttribute('aria-label')).toBe(
    'Called Tail, won RM 100.00, card kept, Abra, won 5 tickets, 30 Oct, 03:52:16 PM',
  );
  const lost = row('both_lost');
  expect(lost.textContent).not.toContain('+');
  expect(lost.getAttribute('aria-label')).toBe(
    'Called Tail, lost, card worth RM 100.00 forfeited, Abra, lost, 5 tickets gone, 30 Oct, 03:52:16 PM',
  );
});

it('shows the cards put in, the call and the result on each row', async () => {
  read.mockResolvedValue({
    ok: true,
    rounds: [
      flip('won', [
        card('a', 'Abra', 100),
        card('b', 'Eevee', 50),
        card('c', 'Mew', 25),
        card('d', 'Zubat', 25),
      ]),
      flip('lost', [card('e', 'Gengar', 180)]),
    ],
    count: 2,
    totals: { head: 1, tail: 1 },
  });
  await render(false);
  const won = row('round_won');
  expect(won.textContent).toContain('Called Tail');
  expect(won.textContent).toContain('Won');
  expect(won.textContent).toContain('Abra');
  expect(won.textContent).toContain('+3');
  expect(won.textContent).toContain('+RM 200.00');
  expect(
    [...won.querySelectorAll('img')].map((i) => i.getAttribute('src')),
  ).toEqual([
    expect.stringContaining('coin-b-tail'),
    '/cdn/a.webp',
    '/cdn/b.webp',
    '/cdn/c.webp',
  ]);
  expect(won.getAttribute('aria-label')).toBe(
    'Called Tail, won RM 200.00, cards kept, Abra and 3 more, 30 Oct, 03:52:16 PM',
  );
  const lost = row('round_lost');
  expect(lost.textContent).toContain('Lost');
  expect(lost.textContent).toContain('Gengar');
  // A loss takes the card, not Credit: never an RM minus or plus.
  expect(lost.textContent).toContain('RM 180.00');
  expect(lost.textContent).not.toMatch(/[-−+]RM/);
  expect(lost.getAttribute('aria-label')).toContain(
    'lost, card worth RM 180.00 forfeited',
  );
});

it('filters on the server, back at page one, and keeps the all-time tally', async () => {
  read.mockResolvedValue({
    ok: true,
    rounds: [flip('won', [card('a', 'Abra', 100)])],
    count: 25,
    totals: { head: 20, tail: 5 },
  });
  await render(false);
  await act(async () => button('Next').click());
  expect(read).toHaveBeenLastCalledWith(2, 'all');
  await act(async () => button('Won').click());
  expect(read).toHaveBeenLastCalledWith(1, 'won');
  expect(button('Won').getAttribute('aria-pressed')).toBe('true');
  expect(host.textContent).toContain('20Landed Head');
  expect(host.textContent).toContain('5Landed Tail');
});

it('locks the pager while a filter is loading, so it cannot land past the end', async () => {
  read.mockResolvedValue({
    ok: true,
    rounds: [flip('won', [card('a', 'Abra', 100)])],
    count: 25,
    totals: { head: 20, tail: 5 },
  });
  await render(false);
  let resolve!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => button('Won').click());
  expect(button('Next').disabled).toBe(true);
  await act(async () =>
    resolve({
      ok: true,
      rounds: [],
      count: 25,
      totals: { head: 20, tail: 5 },
    }),
  );
  expect(button('Next').disabled).toBe(false);
});

it('names the filter when it has no rows, and hides the tally before any flip', async () => {
  read.mockResolvedValue({
    ok: true,
    rounds: [],
    count: 0,
    totals: { head: 0, tail: 0 },
  });
  await render(false);
  expect(host.textContent).toContain('Your completed flips will appear here.');
  expect(host.textContent).not.toContain('Landed');
  read.mockResolvedValue({
    ok: true,
    rounds: [],
    count: 0,
    totals: { head: 0, tail: 3 },
  });
  await act(async () => button('Won').click());
  expect(host.textContent).toContain('No won flips yet.');
});

describe('everyone view', () => {
  const played = (who: string, status: 'won' | 'lost') => ({
    ...flip(status, [card(`${who}-card`, 'Abra', 100)]),
    id: `feed_${who}`,
    who,
    seed: 7,
    profile_handle: null,
    avatar_url: null,
    frame_url: null,
  });
  const show = (paused = false) =>
    act(async () =>
      root.render(createElement(CoinFlipHistory, { paused, everyone: true })),
    );
  afterEach(() => vi.useRealTimers());

  it("opens on every player's flips, named and not clickable", async () => {
    everyone.mockResolvedValue({
      ok: true,
      rounds: [played('Ash', 'won'), played('Misty', 'lost')],
    });
    await show();
    expect(everyone).toHaveBeenCalledExactlyOnceWith('all');
    expect(read).not.toHaveBeenCalled();
    expect(button('Everyone').getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('Ash');
    expect(host.textContent).toContain('Misty');
    expect(host.textContent).toContain('Called Tail');
    expect(host.querySelector('a[href*="round="]')).toBeNull();
    expect(host.textContent).not.toContain('Landed');
    expect(button('Next')).toBeUndefined();
  });

  it('filters everyone on the server and switches to your own flips', async () => {
    everyone.mockResolvedValue({ ok: true, rounds: [] });
    await show();
    expect(host.textContent).toContain('No flips yet.');
    await act(async () => button('Lost').click());
    expect(everyone).toHaveBeenLastCalledWith('lost');
    read.mockResolvedValue({
      ok: true,
      rounds: [flip('won', [card('a', 'Abra', 100)])],
      count: 1,
      totals: { head: 0, tail: 1 },
    });
    await act(async () => button('Mine').click());
    expect(read).toHaveBeenLastCalledWith(1, 'all');
    expect(button('All').getAttribute('aria-pressed')).toBe('true');
    expect(row('round_won')).not.toBeNull();
  });

  it('refreshes every 10 seconds, but not while a toss is in the air', async () => {
    vi.useFakeTimers();
    everyone.mockResolvedValue({ ok: true, rounds: [] });
    await show();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(everyone).toHaveBeenCalledTimes(2);
    await show(true);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(everyone).toHaveBeenCalledTimes(2);
  });

  it('the Transactions page keeps showing only your own flips', async () => {
    await render(false);
    expect(everyone).not.toHaveBeenCalled();
    expect(button('Everyone')).toBeUndefined();
  });
});
