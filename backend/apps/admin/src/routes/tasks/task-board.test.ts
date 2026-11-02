import { describe, expect, test } from 'vitest';
import {
  addWeeks,
  copiedWindow,
  goalAmount,
  leastSpend,
  money,
  nameIssue,
  namePartsOf,
  retiredInWeek,
  runsInWeek,
  sameGoal,
  sameTarget,
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
const credit = (n: number): Partial<AdminTaskDefinition> => ({
  reward: { type: 'credit', amount_myr: n },
  tickets: 0,
});

describe('nameIssue on titles staff have really typed', () => {
  test.each<
    [
      string,
      Record<string, unknown>,
      string | null,
      Partial<AdminTaskDefinition>?,
    ]
  >([
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
    ['Top Up RM1,000 Free RM100 Bonus Credit', topup(1000), null, credit(100)],
    ['Top Up RM300 Free RM30 Bonus Credit', topup(300), null, credit(30)],
    ['Top Up RM100 Free RM10 Bonus Credit', topup(100), null, credit(10)],
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
  ])('matches: %s', (title, requirement, goal, over) => {
    expect(nameIssue(task(title, requirement, goal, over))).toBeNull();
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

describe('nameIssue reads the whole word', () => {
  test.each([
    ['Pull 2 Mewtwo', pull(2), 'Mew'],
    ['Pull 2 Porygon2', pull(2), 'Porygon'],
    ['Pull 1 Tapu Lele', pull(1), 'Tapu Koko'],
    ['Rip 10 Bronze', rip(10), 'Bronze Capsule'],
    ['Rip 10 Bronze Capsule', rip(10), 'Bronze Pack'],
  ])('%s against %s is a different target', (title, requirement, goal) => {
    expect(nameIssue(task(title, requirement, goal))).toEqual({
      kind: 'target',
      wants: goal,
    });
  });

  test.each([
    ['Pull 1 Mr Mime', pull(1), 'Mr. Mime'],
    ['Pull 1 Ho Oh', pull(1), 'Ho-Oh'],
    ['Pull 1 Farfetch’d', pull(1), "Farfetch'd"],
    ['Pull 1 Luffy', pull(1), 'Monkey D. Luffy'],
    ['Pull 1 Luffy', pull(1), 'Monkey D. Luffy (egghead)'],
    ['Rip 3 Pokemon 151', rip(3), 'Pokémon 151'],
    ['Rip 3 Bronze Capsule', rip(3), 'Bronze Capsule'],
  ])('%s matches %s', (title, requirement, goal) => {
    expect(nameIssue(task(title, requirement, goal))).toBeNull();
  });

  test.each<[string, number, string]>([
    ['Rip 3 151', 3, '151'],
    ['Rip 50 pack 30TH free 1 Bronze pack', 50, '30th'],
  ])(
    'a pack named by a number still counts on an any-pack rule: %s',
    (title, n, says) => {
      expect(nameIssue(task(title, rip(n, null)))).toEqual({
        kind: 'any',
        says,
      });
    },
  );

  test.each([
    'Rip 5 packs today',
    'Open 5 packs',
    'Rip 5 of a pack',
    'Rip 5 more packs',
    'Daily rip 5 packs',
    'Rip any 5 packs, free 1 Bronze',
    'Rip 5 packs',
  ])('%s names no pack', (title) => {
    expect(nameIssue(task(title, rip(5, null)))).toBeNull();
  });

  test('"Pull 3 rare cards" names no Pokémon', () => {
    expect(nameIssue(task('Pull 3 rare cards', pull(3, null)))).toBeNull();
    expect(nameIssue(task('Pull 5 Pokémon cards', pull(5, null)))).toBeNull();
  });

  test('vault_count: a plain count passes, a named Pokémon does not', () => {
    const vault = { type: 'vault_count', count: 10 };
    expect(nameIssue(task('Collect 10 cards', vault))).toBeNull();
    expect(nameIssue(task('Vault 10 cards', vault))).toBeNull();
    expect(nameIssue(task('Vault 10 Pikachu', vault))).toEqual({
      kind: 'any',
      says: 'pikachu',
    });
  });

  test('a name holding "free", a comma or a number still passes', () => {
    expect(
      nameIssue(
        task('Rip 2 Free Welcome, free 1 Bronze', rip(2), 'Free Welcome Pack'),
      ),
    ).toBeNull();
    expect(
      nameIssue(task('Rip 2 Sun, Moon, free 1 Gold', rip(2), 'Sun, Moon Pack')),
    ).toBeNull();
    expect(nameIssue(task('Rip 5 Stars', rip(1), '5 Stars'))).toBeNull();
  });
});

describe('nameIssue reads the count without guessing', () => {
  test.each([
    ['Rip 10x Bronze Free 1 Gold', rip(10), 'Bronze Pack'],
    ['Rip Bronze x10', rip(10), 'Bronze Pack'],
    ['Pull 2x Mew', pull(2), 'Mew'],
    ['Pull Mew x2', pull(2), 'Mew'],
    ['Top up RM1.5k', topup(1500), null],
    ['Top up RM 1 000', topup(1000), null],
    ['Top up RM1k', topup(1000), null],
    ['Rip Prismatic 151 Free 1 Bronze', rip(1), 'Prismatic 151'],
    ['Rip 3 151', rip(3), '151'],
    ['Rip 30th Free Bronze', rip(1), '30th Celebration'],
  ])('%s reads right', (title, requirement, goal) => {
    expect(nameIssue(task(title, requirement, goal))).toBeNull();
  });

  test('a real difference in thousands is still caught', () => {
    expect(nameIssue(task('Top up RM1k', topup(500)))).toEqual({
      kind: 'count',
      says: 1000,
    });
  });

  test.each([
    'Free 1 Bronze for 10 Gold rips',
    'Win a Gold: Rip 10 Bronze',
    '抽 2 皮卡丘',
    '抽5包',
  ])('a title it cannot read is left alone, never misread: %s', (title) => {
    expect(nameIssue(task(title, rip(10), 'Gold Pack'))).toBeNull();
  });
});

describe('nameIssue reads the reward', () => {
  test('credit in the name, different credit in the rule', () => {
    expect(
      nameIssue(
        task(
          'Top Up RM1,000 Free RM100 Bonus Credit',
          topup(1000),
          null,
          credit(10),
        ),
      ),
    ).toEqual({ kind: 'reward', says: 'RM 100' });
  });

  test('a decimal amount reads whole', () => {
    expect(
      nameIssue(
        task(
          'Top up RM 100, free RM 5.50 bonus credit',
          topup(100),
          null,
          credit(5.5),
        ),
      ),
    ).toBeNull();
  });

  test('a pack in the name, a different pack in the rule', () => {
    expect(
      nameIssue(
        task('Rip 2 Gold Free 1 Bronze', rip(2), null, {
          reward: { type: 'pack', pack_id: 'r' },
          tickets: 0,
          view: {
            goal_name: 'Gold Pack',
            goal_image: null,
            goal_price_myr: null,
            reward_name: 'Diamond Pack',
            reward_image: null,
            reward_value_myr: null,
          },
        }),
      ),
    ).toEqual({ kind: 'reward', says: '1 bronze' });
  });

  test('tickets in the name, a different count in the rule', () => {
    expect(
      nameIssue(
        task('Rip 2 Gold, 20 tickets', rip(2), 'Gold Pack', { tickets: 50 }),
      ),
    ).toEqual({ kind: 'reward', says: '20 tickets' });
  });

  test('a name that mentions no reward says nothing about it', () => {
    expect(
      nameIssue(task('Rip 2 Gold', rip(2), 'Gold Pack', credit(5))),
    ).toBeNull();
  });
});

describe('nameIssue edges', () => {
  test('a rule naming another target than the name does', () => {
    expect(nameIssue(task('Pull 2 Mew', pull(2), 'Pikachu'))).toEqual({
      kind: 'target',
      wants: 'Pikachu',
    });
  });

  test('a target that no longer exists is not called a mismatch', () => {
    expect(nameIssue(task('Rip 2 Bronze', rip(2, 'gone'), null))).toBeNull();
    expect(nameIssue(task('Pull 2 Mew', pull(2, 'gone'), null))).toBeNull();
  });

  test('a backend that predates view can still read the count', () => {
    const scoped = task('Rip 3 Gold', rip(3));
    delete scoped.view;
    expect(nameIssue(scoped)).toBeNull();
    const wrong = task('Rip 3 Gold', rip(4));
    delete wrong.view;
    expect(nameIssue(wrong)).toEqual({ kind: 'count', says: 3 });
    const pulled = task('Pull 2 Mew', pull(2));
    delete pulled.view;
    expect(nameIssue(pulled)).toBeNull();
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
    expect(taskName({ ...parts, tickets: 1 })).toBe(
      'Rip 10 Bronze, free 1 Bronze + 1 ticket',
    );
  });

  test('one Pokémon card is singular', () => {
    expect(
      taskName({
        ...parts,
        reqType: 'vault_pixel_count',
        n: 1,
        goalName: null,
      }),
    ).toBe('Pull 1 Pokémon card');
    expect(
      taskName({
        ...parts,
        kind: 'achievement',
        reqType: 'vault_pixel_count',
        n: 1,
        goalName: null,
      }),
    ).toBe('Vault 1 Pokémon card');
  });

  test('a long card name stays inside the 120 the backend allows', () => {
    const name = taskName({
      ...parts,
      n: 1,
      goalName: '30th Celebration',
      rewardType: 'card',
      rewardName:
        '2016 Pokemon Japanese Sun & Moon Rockruff Full Power Deck Holo Lycanroc GX #9 CGC 5.5',
      tickets: 20,
    });
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toContain('…');
  });

  test('money shows sen only when there are some', () => {
    expect(money(5)).toBe('RM 5');
    expect(money(5.5)).toBe('RM 5.50');
    expect(money(1234.56)).toBe('RM 1,234.56');
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

  // Whatever the rule says, the name it writes must pass its own check, or a
  // rename fix would leave the row flagged for ever.
  test.each<
    [Record<string, unknown>, string | null, Partial<AdminTaskDefinition>]
  >([
    [checkin(1), null, {}],
    [checkin(1), null, { kind: 'daily' }],
    [pull(1), 'Mew', {}],
    [pull(2), 'Ho-Oh', {}],
    [pull(2), 'Monkey D. Luffy (egghead)', {}],
    [pull(5, null), null, {}],
    [pull(5), 'Mew', { kind: 'achievement' }],
    [pull(1, null), null, { kind: 'achievement' }],
    [rip(10), 'Bronze Pack', credit(5)],
    [rip(10, null), null, credit(5)],
    [rip(3), '151', {}],
    [rip(2), 'Free Welcome Pack', {}],
    [rip(2), 'Sun, Moon Pack', { tickets: 7 }],
    [rip(5), '30th Celebration', credit(100)],
    [topup(1000), null, credit(100)],
    [topup(100), null, credit(5.5)],
    [topup(100), null, {}],
    [{ type: 'reach_level', level: 50 }, null, { kind: 'achievement' }],
    [{ type: 'vault_count', count: 1 }, null, { kind: 'achievement' }],
    [{ type: 'vault_count', count: 9 }, null, { kind: 'achievement' }],
  ])('a generated name passes its own check: %j', (requirement, goal, over) => {
    const t = task('placeholder', requirement, goal, over);
    t.title = taskName(namePartsOf(t));
    expect(nameIssue(t)).toBeNull();
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

  test('the same holds with no start at all', () => {
    const t = task('x', checkin(1), null, { ends_at: '2026-11-08T16:59:00Z' });
    expect(runsInWeek(t, monday)).toBe(true);
    expect(runsInWeek(t, addWeeks(monday, 1))).toBe(false);
  });

  test('a start typed just before the reset belongs to the week after', () => {
    const t = task('x', checkin(1), null, {
      starts_at: '2026-11-08T15:59:00Z',
      ends_at: '2026-11-15T15:59:00Z',
    });
    expect(runsInWeek(t, monday)).toBe(false);
    expect(runsInWeek(t, addWeeks(monday, 1))).toBe(true);
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

  test('a retired task shows in each week it ran, up to when it was retired', () => {
    const t = task('x', checkin(1), null, {
      active: false,
      retired_at: '2026-11-02T06:29:00Z',
    });
    expect(retiredInWeek(t, monday)).toBe(true);
    expect(retiredInWeek(t, addWeeks(monday, -1))).toBe(true);
    expect(retiredInWeek(t, addWeeks(monday, 1))).toBe(false);
    expect(retiredInWeek({ ...t, retired_at: null }, monday)).toBe(false);
    expect(retiredInWeek({ ...t, active: true }, monday)).toBe(false);
  });

  test('a row retired later is not listed in a week it never ran', () => {
    const t = task('x', checkin(1), null, {
      active: false,
      starts_at: '2026-11-01T16:00:00Z',
      ends_at: '2026-11-08T16:00:00Z',
      retired_at: '2026-11-20T00:00:00Z',
    });
    expect(retiredInWeek(t, monday)).toBe(true);
    expect(retiredInWeek(t, addWeeks(monday, 1))).toBe(false);
  });
});

describe('copiedWindow', () => {
  const monday = Date.parse('2026-11-01T16:00:00Z');
  const next = '2026-11-08T16:00:00.000Z';
  const after = '2026-11-15T16:00:00.000Z';

  test('a whole week copies to the whole next week', () => {
    expect(
      copiedWindow(
        task('x', checkin(1), null, {
          starts_at: '2026-11-01T16:00:00Z',
          ends_at: '2026-11-08T16:00:00Z',
        }),
        monday,
      ),
    ).toEqual({ starts_at: next, ends_at: after, short: false });
  });

  test('a typed overrun of the reset still counts as a whole week', () => {
    expect(
      copiedWindow(
        task('x', checkin(1), null, {
          starts_at: '2026-11-01T16:00:00Z',
          ends_at: '2026-11-08T16:59:00Z',
        }),
        monday,
      ),
    ).toEqual({ starts_at: next, ends_at: after, short: false });
  });

  test('a shorter window keeps its shape, a week on', () => {
    expect(
      copiedWindow(
        task('x', checkin(1), null, {
          starts_at: '2026-11-03T04:00:00Z',
          ends_at: '2026-11-04T04:00:00Z',
        }),
        monday,
      ),
    ).toEqual({
      starts_at: '2026-11-10T04:00:00.000Z',
      ends_at: '2026-11-11T04:00:00.000Z',
      short: true,
    });
  });

  test('no window copies to the whole next week', () => {
    expect(copiedWindow(task('x', checkin(1)), monday)).toEqual({
      starts_at: next,
      ends_at: after,
      short: false,
    });
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

  test('a changed reward amount is still the same task, so it is not copied twice', () => {
    expect(
      sameGoal(task('a', pull(2)), task('a', pull(2), null, { tickets: 50 })),
    ).toBe(true);
    expect(
      sameGoal(
        task('a', topup(100), null, credit(10)),
        task('a', topup(100), null, credit(25)),
      ),
    ).toBe(true);
  });

  test('a leftover key from an older rule changes nothing', () => {
    expect(
      sameGoal(
        task('a', topup(100), null, {
          reward: { type: 'credit', amount_myr: 10, pack_id: 'old' },
        }),
        task('b', topup(100), null, credit(10)),
      ),
    ).toBe(true);
    expect(
      sameGoal(task('a', { ...pull(2), pack_id: 'old' }), task('b', pull(2))),
    ).toBe(true);
  });

  test('a different count, target or reward kind is another task', () => {
    expect(sameGoal(task('a', pull(2)), task('a', pull(3)))).toBe(false);
    expect(sameGoal(task('a', pull(2, 'x')), task('a', pull(2, 'y')))).toBe(
      false,
    );
    expect(
      sameGoal(task('a', pull(2)), task('a', pull(2), null, credit(5))),
    ).toBe(false);
  });
});

describe('sameTarget', () => {
  test('the same goal on the same target, whatever the count', () => {
    expect(sameTarget(task('a', pull(2)), task('b', pull(5)))).toBe(true);
    expect(sameTarget(task('a', pull(2, 'x')), task('b', pull(2, 'y')))).toBe(
      false,
    );
    expect(sameTarget(task('a', rip(2)), task('b', pull(2)))).toBe(false);
  });
});
