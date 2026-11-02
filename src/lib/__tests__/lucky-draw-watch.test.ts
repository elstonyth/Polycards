import { describe, expect, test } from 'vitest';
import {
  BATCH_WAIT_MS,
  batchWaitUntil,
  cornerLift,
  drawMinute,
  dueGate,
  firstLookAt,
  freshShows,
  LIVE_MAX_AGE_MS,
  mergeWatched,
  nextLookAt,
  nextWake,
  placeShow,
  WATCH_WINDOW_MS,
} from '../lucky-draw-watch';

const MIN = 60_000;
const at = (m: number) => m * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const never = new Set<string>();

describe('gates in one draw minute', () => {
  const watched = (id: string, endsAt: number) => ({
    id,
    endsAt,
    lookAt: endsAt,
  });
  const show = (
    id: string,
    tier: string | null,
    value: number,
    endsAt = at(10),
  ) => ({ id, endsAt, detail: { result: { tier, value_myr: value } } });
  const ids = (q: readonly { id: string }[]) => q.map((s) => s.id);

  test('a gate belongs to the minute the draw job next runs on', () => {
    expect(drawMinute(at(10))).toBe(at(10));
    expect(drawMinute(at(10) + 1)).toBe(at(11));
    expect(drawMinute(at(10) + 59_999)).toBe(at(11));
    expect(firstLookAt(at(10) + 1, 0)).toBe(at(11) + 2000);
  });

  test('the wait outlasts every look a tab can make, and ends before a draw goes stale', () => {
    const lastFirstLook = firstLookAt(at(10), 1) - at(10);
    const oneRetry = nextLookAt(0, 1);
    expect(BATCH_WAIT_MS).toBeGreaterThan(lastFirstLook + 2 * oneRetry);
    // A draw that fails retries on the next job run, a minute on.
    expect(BATCH_WAIT_MS).toBeGreaterThan(MIN + oneRetry);
    expect(BATCH_WAIT_MS).toBeLessThan(LIVE_MAX_AGE_MS);
  });

  test('waits while another gate of the minute is unread, and only then', () => {
    const soon = at(10) + 3000;
    expect(batchWaitUntil([watched('b', at(10))], at(10), soon)).toBe(
      at(10) + BATCH_WAIT_MS,
    );
    expect(batchWaitUntil([], at(10), soon)).toBeNull();
    expect(batchWaitUntil([watched('b', at(11))], at(10), soon)).toBeNull();
  });

  test('a tab past the wait still gets a moment to read the rest', () => {
    const late = at(10) + BATCH_WAIT_MS + 5000;
    const until = batchWaitUntil([watched('b', at(10))], at(10), late);
    // Long enough for the other gate's next look, and no longer than one more.
    expect((until ?? 0) - late).toBeGreaterThan(nextLookAt(0, 1));
    expect((until ?? 0) - late).toBeLessThan(2 * nextLookAt(0, 1));
  });

  test('ends differing inside a minute share it, and class decides', () => {
    expect(
      ids(
        placeShow(
          [show('f', 'first', 1, at(10) - 20_000)],
          show('e', 'economy', 1),
          null,
        ),
      ),
    ).toEqual(['e', 'f']);
  });

  test('a tie falls to the id, whichever came in first', () => {
    expect(
      ids(
        placeShow([show('b', 'economy', 200)], show('a', 'economy', 200), null),
      ),
    ).toEqual(['a', 'b']);
  });

  test('sorts by minute, then class, then smallest prize, then id', () => {
    let q = placeShow([], show('first', 'first', 1), null);
    q = placeShow(q, show('bigger', 'economy', 500), null);
    q = placeShow(q, show('smaller', 'economy', 200), null);
    q = placeShow(q, show('business', 'business', 1), null);
    q = placeShow(q, show('none', null, 1), null);
    q = placeShow(q, show('tie-b', 'economy', 200), null);
    q = placeShow(q, show('earlier', 'first', 9, at(9)), null);
    expect(ids(q)).toEqual([
      'earlier',
      'smaller',
      'tie-b',
      'bigger',
      'business',
      'first',
      'none',
    ]);
  });

  test('never moves the show already playing', () => {
    const q = [show('first', 'first', 1), show('z', 'first', 9)];
    expect(ids(placeShow(q, show('economy', 'economy', 1), 'first'))).toEqual([
      'first',
      'economy',
      'z',
    ]);
    expect(ids(placeShow(q, show('economy', 'economy', 1), 'gone'))).toEqual([
      'economy',
      'first',
      'z',
    ]);
  });
});

describe('freshShows', () => {
  const show = (ageMs: number) => ({
    detail: { result: { drawn_at: new Date(1_000_000 - ageMs).toISOString() } },
  });

  test('keeps the young, drops the old, at the limit too', () => {
    const young = show(999);
    expect(freshShows([young, show(1000)], 1_000_000, 1000)).toEqual([young]);
  });

  test('the same list when nothing went, so nobody re-renders', () => {
    const q = [show(1), show(2)];
    expect(freshShows(q, 1_000_000, 1000)).toBe(q);
  });
});

describe('firstLookAt', () => {
  test('never before the first minute after the end, when the job can have run', () => {
    const end = at(100) + 17_000;
    expect(firstLookAt(end, 0)).toBeGreaterThan(at(101));
    expect(firstLookAt(end, 1)).toBeLessThan(at(101) + 45_000);
  });

  test('a gate ending on the minute is looked for just after it', () => {
    expect(firstLookAt(at(100), 0)).toBeGreaterThan(at(100));
    expect(firstLookAt(at(100), 0)).toBeLessThan(at(100) + 5_000);
  });

  test('tabs spread out over several seconds, not one instant', () => {
    expect(firstLookAt(at(100), 1) - firstLookAt(at(100), 0)).toBeGreaterThan(
      8_000,
    );
  });
});

test('looks again some seconds later, jittered', () => {
  expect(nextLookAt(1000, 0)).toBeGreaterThan(1000 + 5_000);
  expect(nextLookAt(1000, 1)).toBeGreaterThan(nextLookAt(1000, 0));
});

describe('mergeWatched', () => {
  const rand = () => 0;

  test('adds a new gate and keeps a known one untouched', () => {
    const first = mergeWatched(
      [],
      [{ id: 'a', ends_at: iso(at(100)) }],
      never,
      at(90),
      rand,
    );
    expect(first).toHaveLength(1);
    const pushed = [{ ...first[0]!, lookAt: 12345 }];
    const again = mergeWatched(
      pushed,
      [{ id: 'a', ends_at: iso(at(100)) }],
      never,
      at(90),
      rand,
    );
    expect(again[0]?.lookAt).toBe(12345);
  });

  test('a moved end moves the look', () => {
    const first = mergeWatched(
      [],
      [{ id: 'a', ends_at: iso(at(100)) }],
      never,
      at(90),
      rand,
    );
    const moved = mergeWatched(
      first,
      [{ id: 'a', ends_at: iso(at(120)) }],
      never,
      at(90),
      rand,
    );
    expect(moved[0]?.lookAt).toBeGreaterThan(at(120));
  });

  test('a gate gone from the list is still watched: a drawn gate leaves it', () => {
    const first = mergeWatched(
      [],
      [{ id: 'a', ends_at: iso(at(100)) }],
      never,
      at(90),
      rand,
    );
    expect(mergeWatched(first, [], never, at(101), rand)).toHaveLength(1);
  });

  test('stops at the window, and never brings back a finished gate', () => {
    const first = mergeWatched(
      [],
      [{ id: 'a', ends_at: iso(at(100)) }],
      never,
      at(90),
      rand,
    );
    expect(
      mergeWatched(first, [], never, at(100) + WATCH_WINDOW_MS, rand),
    ).toHaveLength(0);
    expect(
      mergeWatched(
        first,
        [{ id: 'a', ends_at: iso(at(100)) }],
        new Set(['a']),
        at(90),
        rand,
      ),
    ).toHaveLength(0);
  });

  test('ignores an end it cannot read', () => {
    expect(
      mergeWatched([], [{ id: 'a', ends_at: 'soon' }], never, at(90), rand),
    ).toHaveLength(0);
  });
});

describe('cornerLift', () => {
  test('clears the Open bar on a pack page, not on the catalog or a rip', () => {
    expect(cornerLift('/slots/lucky-pack')).toBe('bar');
    expect(cornerLift('/slots')).toBe('tabs');
    expect(cornerLift('/slots/lucky-pack/spin')).toBe('tabs');
  });

  test('clears the action tray on the vault and the leaderboard', () => {
    expect(cornerLift('/vault')).toBe('tray');
    expect(cornerLift('/vault/history')).toBe('tray');
    expect(cornerLift('/leaderboard')).toBe('tray');
  });

  test('everywhere else it sits just above the tab bar', () => {
    expect(cornerLift('/')).toBe('tabs');
    expect(cornerLift('/lucky-draw')).toBe('tabs');
    expect(cornerLift('/vaulted')).toBe('tabs');
  });
});

describe('dueGate and nextWake', () => {
  const list = [
    { id: 'a', endsAt: 0, lookAt: 500 },
    { id: 'b', endsAt: 0, lookAt: 200 },
    { id: 'c', endsAt: 0, lookAt: 900 },
  ];

  test('takes the most overdue', () => {
    expect(dueGate(list, 600)?.id).toBe('b');
  });

  test('nothing due, nothing taken', () => {
    expect(dueGate(list, 100)).toBeNull();
  });

  test('wakes for the soonest, or not at all', () => {
    expect(nextWake(list)).toBe(200);
    expect(nextWake([])).toBeNull();
  });
});
