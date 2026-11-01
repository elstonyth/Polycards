import { describe, expect, test } from 'vitest';
import {
  cornerLift,
  dueGate,
  firstLookAt,
  freshShows,
  mergeWatched,
  nextLookAt,
  nextWake,
  WATCH_WINDOW_MS,
} from '../lucky-draw-watch';

const MIN = 60_000;
const at = (m: number) => m * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const never = new Set<string>();

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
