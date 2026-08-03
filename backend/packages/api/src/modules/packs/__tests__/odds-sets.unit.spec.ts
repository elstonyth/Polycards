import type { MedusaContainer } from '@medusajs/framework/types';
import {
  DEFAULT_PLAYER_GROUP_NAME,
  coerceOddsSet,
  resolveOddsSetForCustomer,
  weightForSet,
} from '../odds-sets';

describe('weightForSet', () => {
  it('falls back to set 1 when 2 and 3 are empty', () => {
    const o = { weight: 100 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(100);
    expect(weightForSet(o, 3)).toBe(100);
  });

  it('inherits set 3 from set 2 when only 2 is set', () => {
    const o = { weight: 100, weight_2: 200 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(200);
    expect(weightForSet(o, 3)).toBe(200);
  });

  it('uses every set verbatim when all three are set', () => {
    const o = { weight: 100, weight_2: 200, weight_3: 300 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(200);
    expect(weightForSet(o, 3)).toBe(300);
  });

  it('skips an empty set 2 without dragging set 3 down', () => {
    const o = { weight: 100, weight_3: 300 };
    expect(weightForSet(o, 1)).toBe(100);
    expect(weightForSet(o, 2)).toBe(100);
    expect(weightForSet(o, 3)).toBe(300);
  });

  it('treats an explicit 0 as a real weight, not an empty set', () => {
    const o = { weight: 100, weight_2: 0 };
    expect(weightForSet(o, 2)).toBe(0);
    // set 3 inherits the explicit 0 from set 2 — never rolls back to set 1.
    expect(weightForSet(o, 3)).toBe(0);
    expect(weightForSet({ weight: 100, weight_3: 0 }, 3)).toBe(0);
  });

  it('treats null as empty (a cleared column, not a 0 weight)', () => {
    const o = { weight: 100, weight_2: null, weight_3: null };
    expect(weightForSet(o, 2)).toBe(100);
    expect(weightForSet(o, 3)).toBe(100);
  });
});

describe('coerceOddsSet', () => {
  it('accepts sets 2 and 3 as number or string', () => {
    expect(coerceOddsSet(2)).toBe(2);
    expect(coerceOddsSet('2')).toBe(2);
    expect(coerceOddsSet(3)).toBe(3);
    expect(coerceOddsSet('3')).toBe(3);
  });

  it('rolls anything else to set 1', () => {
    for (const v of [1, '1', 0, 4, 'x', null, undefined, {}]) {
      expect(coerceOddsSet(v)).toBe(1);
    }
  });
});

describe('resolveOddsSetForCustomer', () => {
  // listCustomerGroups is asked for created_at ASC, so the fixtures are written
  // oldest-first — index 0 is what plain "take the first row" would pick.
  const containerWith = (
    groups: { name: string; metadata?: Record<string, unknown> }[],
  ) =>
    ({
      resolve: () => ({ listCustomerGroups: async () => groups }),
    }) as unknown as MedusaContainer;

  it('is set 1 for an anonymous / demo roll', async () => {
    await expect(
      resolveOddsSetForCustomer(containerWith([]), undefined),
    ).resolves.toBe(1);
  });

  it('is set 1 for a customer in no group', async () => {
    await expect(
      resolveOddsSetForCustomer(containerWith([]), 'cus_1'),
    ).resolves.toBe(1);
  });

  it('reads the group metadata', async () => {
    const c = containerWith([{ name: 'pro', metadata: { odds_set: 3 } }]);
    await expect(resolveOddsSetForCustomer(c, 'cus_1')).resolves.toBe(3);
  });

  // The regression this guards: DEFAULT is created on the first sign-up, so it
  // is OLDER than any group an operator makes later. Oldest-wins alone would
  // hand back set 1 here and moving a player into "pro" would do nothing.
  it('skips the DEFAULT group even when it is the oldest', async () => {
    const c = containerWith([
      { name: DEFAULT_PLAYER_GROUP_NAME, metadata: { odds_set: 1 } },
      { name: 'pro', metadata: { odds_set: 2 } },
    ]);
    await expect(resolveOddsSetForCustomer(c, 'cus_1')).resolves.toBe(2);
  });

  // The default group is a LABEL, not a rule: its members must roll exactly
  // like a customer with no group at all. If a stray odds_set on that row
  // applied, a backfilled player and a player the fail-soft subscriber missed
  // — indistinguishable in the admin — would silently roll different odds.
  it('pins the default group to set 1 whatever its row stores', async () => {
    const c = containerWith([
      { name: DEFAULT_PLAYER_GROUP_NAME, metadata: { odds_set: 3 } },
    ]);
    await expect(resolveOddsSetForCustomer(c, 'cus_1')).resolves.toBe(1);
  });

  // The name is not identity — the prebuilt /customer-groups screen can rename
  // the group, and a rename must not promote it to a "real" group whose odds
  // then win for every member (it is the oldest).
  it('recognises the default group by its metadata marker after a rename', async () => {
    const c = containerWith([
      { name: 'House', metadata: { is_default: true, odds_set: 3 } },
      { name: 'pro', metadata: { odds_set: 2 } },
    ]);
    await expect(resolveOddsSetForCustomer(c, 'cus_1')).resolves.toBe(2);
  });

  it('keeps oldest-wins among two real groups', async () => {
    const c = containerWith([
      { name: 'pro', metadata: { odds_set: 2 } },
      { name: 'whale', metadata: { odds_set: 3 } },
    ]);
    await expect(resolveOddsSetForCustomer(c, 'cus_1')).resolves.toBe(2);
  });
});
