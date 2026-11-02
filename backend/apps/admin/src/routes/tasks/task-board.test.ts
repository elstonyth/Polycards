import { describe, expect, test } from 'vitest';
import {
  addWeeks,
  goalAmount,
  leastSpend,
  nameIssue,
  namePartsOf,
  retiredInWeek,
  runsInWeek,
  sameGoal,
  shortPack,
  taskName,
  weekLabel,
  weekStart,
} from './task-board';
import type { AdminTaskDefinition } from '../../lib/admin-rest';

const task = (
  title: string,
  requirement: Record<string, unknown>,
  goal_name: string | null = null,
  over: Partial<AdminTaskDefinition> = {},
): AdminTaskDefinition => ({
  id: 't',
  kind: 'weekly',
  title,
  requirement,
  reward: { type: 'tickets' },
  active: true,
  sort: 0,
  tickets: 20,
  starts_at: null,
  ends_at: null,
  retired_at: null,
  claims: 0,
  view: {
    goal_name,
    goal_image: null,
    goal_price_myr: null,
    reward_name: null,
    reward_image: null,
    reward_value_myr: null,
  },
  ...over,
});
const pull = (n: number, id: string | null = 'px') => ({
  type: 'vault_pixel_count',
  count: n,
  pixel_pokemon_id: id,
});
const rip = (n: number, id: string | null = 'p') => ({
  type: 'rip_count',
  count: n,
  pack_id: id,
});
const checkin = (n: number) => ({ type: 'checkin_days', days: n });
const topup = (n: number) => ({ type: 'topup_myr', amount_myr: n });

describe('nameIssue on titles staff have really typed', () => {
  test.each([
    ['Pull 2 Dragonite (Graded or Ungraded)', pull(2), 'Dragonite'],
    ['Pull 1 Rayquaza (Graded or Ungraded)', pull(1), 'Rayquaza'],
    ['Pull 1 Magikarp (Graded or Ungraded)', pull(1), 'Magikarp'],
    ['Pull 2 Gengar (Graded or Ungraded)', pull(2), 'Gengar'],
    ['Pull 1 Lugia (Graded or Ungraded)', pull(1), 'Lugia'],
    ['Pull 2 Mewtwo (Graded or Ungraded)', pull(2), 'Mewtwo'],
    ['Pull 3 Mewtwo (Graded or Ungraded)', pull(3), 'Mewtwo'],
    ['Pull 2 Charizard (Graded or Ungraded)', pull(2), 'Charizard'],
    ['Pull 10 Pikachu (Graded or Ungraded)', pull(10), 'Pikachu'],
    ['Collect 10 Pikachu', pull(10), 'Pikachu'],
    ['Top Up RM1,000 Free RM100 Bonus Credit', topup(1000), null],
    ['Top Up RM300 Free RM30 Bonus Credit', topup(300), null],
    ['Top Up RM100 Free RM10 Bonus Credit', topup(100), null],
    ['RIp 2 Diamond Free Gold', rip(2), 'Diamond Pack'],
    ['RIp 2 Platinum Free Silver', rip(2), 'Platinum Pack'],
    ['RIp 2 Gold Free 1 Bronze', rip(2), 'Gold Pack'],
    ['RIp 5 Silver Free 1 Bronze pack', rip(5), 'Silver Pack'],
    ['RIp Silver Free 30th pack', rip(1), 'Silver Pack'],
    ['RIp Silver Free 30th', rip(1), 'Silver Pack'],
    ['Rip Silver Win 30th', rip(1), 'Silver Pack'],
    ['Rip 10 Bronze Free 1 Bronze', rip(10), 'Bronze Pack'],
    ['Rip 50 pack 30TH free 1 Bronze pack', rip(50), '30th Celebration'],
    ['Rip 1 Pack Platinum Free 1 Bronze', rip(1), 'Platinum Pack'],
    ['Rip 50 pack Bronze free 1 Gold pack', rip(50), 'Bronze Pack'],
    ['RIp 2 Bronze Free 30th', rip(2), 'Bronze Pack'],
    ['Check in 1 days this week', checkin(1), null],
    ['Check in 2 days this week', checkin(2), null],
    ['Check in 3 days this week', checkin(3), null],
    ['Check in 5 days this week', checkin(5), null],
    ['Check in 6 days this week', checkin(6), null],
    ['Check in 7 days this week', checkin(7), null],
    ['Reach lvl 100', { type: 'reach_level', level: 100 }, null],
    ['Reach lvl 10', { type: 'reach_level', level: 10 }, null],
    ['Vault 2 Pikachu cards', pull(2), 'Pikachu'],
  ])('matches: %s', (title, requirement, goal) => {
    expect(nameIssue(task(title, requirement, goal))).toBeNull();
  });

  test('a pack in the name, any pack in the rule', () => {
    expect(
      nameIssue(task('Rip 10 Bronze Free 1 Bronze', rip(10, null))),
    ).toEqual({ kind: 'any', says: 'bronze' });
  });

  test('2 in the name, 1 in the rule', () => {
    expect(
      nameIssue(task('Pull 2 Mew (Graded or Ungraded)', pull(1), 'Mew')),
    ).toEqual({ kind: 'count', says: 2 });
  });

  test('a pull name on a check-in rule', () => {
    expect(
      nameIssue(task('Pull 2 Eevee (Graded or Ungraded)', checkin(1))),
    ).toEqual({ kind: 'goal', says: 'Pull' });
  });

  test('a stale days from an older goal does not hide a wrong count', () => {
    expect(
      nameIssue(
        task(
          'Pull 2 Eevee (Graded or Ungraded)',
          { days: 1, ...pull(1) },
          'Eevee',
        ),
      ),
    ).toEqual({ kind: 'count', says: 2 });
  });

  test('a daily "Check in 2 days" that counts one', () => {
    expect(
      nameIssue(
        task('Check in 2 days this week', checkin(1), null, { kind: 'daily' }),
      ),
    ).toEqual({ kind: 'count', says: 2 });
  });
});

describe('nameIssue edges', () => {
  test('a pack named by a number is not read as the count', () => {
    expect(nameIssue(task('Rip 3 151', rip(3), '151'))).toBeNull();
    expect(
      nameIssue(task('Rip 30th Free Bronze', rip(1), '30th Celebration')),
    ).toBeNull();
  });

  test('"any" in the name agrees with an any-pack rule', () => {
    expect(
      nameIssue(task('Rip any 10 packs, free 1 Bronze', rip(10, null))),
    ).toBeNull();
    expect(nameIssue(task('Rip 10 packs', rip(10, null)))).toBeNull();
    expect(nameIssue(task('Pull 5 Pokémon cards', pull(5, null)))).toBeNull();
  });

  test('a rule naming another target than the name does', () => {
    expect(nameIssue(task('Pull 2 Mew', pull(2), 'Pikachu'))).toEqual({
      kind: 'target',
      wants: 'Pikachu',
    });
  });

  test('a target that no longer exists is not called a mismatch', () => {
    expect(nameIssue(task('Rip 2 Bronze', rip(2, 'gone'), null))).toBeNull();
  });

  test('a backend that predates view still renders', () => {
    const stale = task('Check in 2 days this week', checkin(2));
    delete stale.view;
    expect(nameIssue(stale)).toBeNull();
  });

  test.each([
    ['Check in 1 day this week', checkin(1), null],
    ['Pull 2 Mew (Graded or Ungraded)', pull(2), 'Mew'],
    ['Rip any 10 packs, free 1 Bronze', rip(10, null), null],
    ['Rip 10 Bronze, free 1 Bronze', rip(10), 'Bronze Pack'],
    ['Top up RM 1,000, free RM 100 bonus credit', topup(1000), null],
  ])('a generated name always passes: %s', (title, requirement, goal) => {
    expect(nameIssue(task(title, requirement, goal))).toBeNull();
  });
});

describe('taskName', () => {
  const parts = {
    kind: 'weekly' as const,
    reqType: 'rip_count',
    n: 10,
    goalName: 'Bronze Pack',
    rewardType: 'pack',
    rewardName: 'Bronze Pack',
    rewardAmount: 0,
    tickets: 0,
  };

  test('writes each goal from the rule', () => {
    expect(taskName(parts)).toBe('Rip 10 Bronze, free 1 Bronze');
    expect(taskName({ ...parts, goalName: null })).toBe(
      'Rip any 10 packs, free 1 Bronze',
    );
    expect(
      taskName({ ...parts, reqType: 'checkin_days', n: 1, goalName: null }),
    ).toBe('Check in 1 day this week');
    expect(
      taskName({
        ...parts,
        kind: 'daily',
        reqType: 'checkin_days',
        n: 1,
        goalName: null,
      }),
    ).toBe('Check in today');
    expect(
      taskName({
        ...parts,
        reqType: 'vault_pixel_count',
        n: 2,
        goalName: 'Mew',
        rewardType: 'tickets',
        tickets: 20,
      }),
    ).toBe('Pull 2 Mew (Graded or Ungraded)');
    expect(
      taskName({
        ...parts,
        reqType: 'topup_myr',
        n: 1000,
        goalName: null,
        rewardType: 'credit',
        rewardAmount: 100,
      }),
    ).toBe('Top up RM 1,000, free RM 100 bonus credit');
    expect(
      taskName({ ...parts, reqType: 'reach_level', n: 50, goalName: null }),
    ).toBe('Reach VIP level 50');
  });

  test('says tickets a reward pays on top', () => {
    expect(taskName({ ...parts, tickets: 5 })).toBe(
      'Rip 10 Bronze, free 1 Bronze + 5 tickets',
    );
    expect(taskName({ ...parts, rewardType: 'tickets', tickets: 1 })).toBe(
      'Rip 10 Bronze, 1 ticket',
    );
  });

  test('namePartsOf reads a saved row by its goal type', () => {
    const t = task('x', { days: 1, ...pull(2) }, 'Mew');
    expect(namePartsOf(t)).toMatchObject({ n: 2, goalName: 'Mew' });
    expect(goalAmount({ type: 'topup_myr', amount_myr: 300, count: 9 })).toBe(
      300,
    );
  });

  test('shortPack keeps a name that is not "… Pack"', () => {
    expect(shortPack('Bronze Pack')).toBe('Bronze');
    expect(shortPack('30th Celebration')).toBe('30th Celebration');
  });
});

describe('weeks, in Malaysia time', () => {
  // Monday 2 Nov 2026 00:00 MYT
  const monday = Date.parse('2026-11-01T16:00:00Z');

  test('the week starts Monday 00:00 MYT', () => {
    expect(weekStart(monday)).toBe(monday);
    expect(weekStart(monday - 1)).toBe(addWeeks(monday, -1));
    expect(weekStart(Date.parse('2026-11-08T15:59:59Z'))).toBe(monday);
    expect(weekStart(Date.parse('2026-11-08T16:00:00Z'))).toBe(
      addWeeks(monday, 1),
    );
  });

  test('labels', () => {
    expect(weekLabel(monday)).toBe('2 – 8 Nov');
    expect(weekLabel(Date.parse('2026-11-29T16:00:00Z'))).toBe(
      '30 Nov – 6 Dec',
    );
  });

  test('a task runs in the weeks its window touches', () => {
    const t = task('x', checkin(1), null, {
      starts_at: '2026-11-01T16:00:00Z',
      ends_at: '2026-11-08T16:00:00Z',
    });
    expect(runsInWeek(t, monday)).toBe(true);
    expect(runsInWeek(t, addWeeks(monday, -1))).toBe(false);
    expect(runsInWeek(t, addWeeks(monday, 1))).toBe(false);
    expect(runsInWeek(task('x', checkin(1)), addWeeks(monday, 9))).toBe(true);
    expect(runsInWeek({ ...t, active: false }, monday)).toBe(false);
  });

  test('an end typed a little past the reset stays in its own week', () => {
    // A hand-typed end of Monday 12:59 AM.
    const t = task('x', checkin(1), null, {
      starts_at: '2026-11-01T16:00:00Z',
      ends_at: '2026-11-08T16:59:00Z',
    });
    expect(runsInWeek(t, monday)).toBe(true);
    expect(runsInWeek(t, addWeeks(monday, 1))).toBe(false);
  });

  test('a task that really carries over shows in both weeks', () => {
    const t = task('x', checkin(1), null, {
      starts_at: '2026-11-01T16:00:00Z',
      ends_at: '2026-11-10T16:00:00Z',
    });
    expect(runsInWeek(t, monday)).toBe(true);
    expect(runsInWeek(t, addWeeks(monday, 1))).toBe(true);
  });

  test('a short task inside one week still shows there', () => {
    const t = task('x', checkin(1), null, {
      starts_at: '2026-11-03T04:00:00Z',
      ends_at: '2026-11-03T05:00:00Z',
    });
    expect(runsInWeek(t, monday)).toBe(true);
  });

  test('a retired task shows in the week it was retired', () => {
    const t = task('x', checkin(1), null, {
      active: false,
      retired_at: '2026-11-02T06:29:00Z',
    });
    expect(retiredInWeek(t, monday)).toBe(true);
    expect(retiredInWeek(t, addWeeks(monday, 1))).toBe(false);
    expect(retiredInWeek({ ...t, retired_at: null }, monday)).toBe(false);
  });
});

describe('leastSpend', () => {
  test('rips cost their count, top-ups their amount, the rest nothing', () => {
    expect(leastSpend('rip_count', 10, 10)).toBe(100);
    expect(leastSpend('rip_count', 10, null)).toBeNull();
    expect(leastSpend('topup_myr', 300, null)).toBe(300);
    expect(leastSpend('vault_pixel_count', 2, null)).toBeNull();
    expect(leastSpend('checkin_days', 1, null)).toBeNull();
  });
});

describe('sameGoal', () => {
  test('the same rule and reward is the same task, whatever the name', () => {
    expect(sameGoal(task('a', pull(2)), task('b', pull(2)))).toBe(true);
  });
  test('any difference in rule or reward is not', () => {
    expect(sameGoal(task('a', pull(2)), task('a', pull(3)))).toBe(false);
    expect(sameGoal(task('a', pull(2, 'x')), task('a', pull(2, 'y')))).toBe(
      false,
    );
    expect(
      sameGoal(task('a', pull(2)), task('a', pull(2), null, { tickets: 50 })),
    ).toBe(false);
  });
});
