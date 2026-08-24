import {
  taskProgress,
  validateTaskRequirement,
  validateTaskReward,
  type TaskFacts,
} from '../tasks';

const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  checkinDaysThisWeek: 0,
  ripsThisWeek: 0,
  ripsThisWeekByPack: new Map(),
  vipLevel: 1,
  vaultCount: 0,
  vaultPixelCount: 0,
  ...over,
});

describe('validateTaskRequirement', () => {
  it('binds requirement families to their cadence', () => {
    expect(
      validateTaskRequirement('weekly', { type: 'checkin_days', days: 5 }),
    ).toEqual({ type: 'checkin_days', days: 5 });
    expect(
      validateTaskRequirement('achievement', {
        type: 'reach_level',
        level: 10,
      }),
    ).toEqual({ type: 'reach_level', level: 10 });
    // A lifetime fact cannot be a weekly task, and vice versa.
    expect(() =>
      validateTaskRequirement('weekly', { type: 'reach_level', level: 10 }),
    ).toThrow(/weekly/i);
    expect(() =>
      validateTaskRequirement('achievement', { type: 'rip_count', count: 3 }),
    ).toThrow(/achievement/i);
  });

  it('bounds the numbers', () => {
    expect(() =>
      validateTaskRequirement('weekly', { type: 'checkin_days', days: 8 }),
    ).toThrow(/1\.\.7/);
    expect(() =>
      validateTaskRequirement('weekly', { type: 'rip_count', count: 0 }),
    ).toThrow(/positive/i);
    expect(() =>
      validateTaskRequirement('achievement', {
        type: 'reach_level',
        level: 101,
      }),
    ).toThrow(/1\.\.100/);
  });

  it('normalizes rip_count pack filter', () => {
    expect(
      validateTaskRequirement('weekly', { type: 'rip_count', count: 3 }),
    ).toEqual({ type: 'rip_count', count: 3, pack_id: null });
  });
});

describe('validateTaskReward', () => {
  it('accepts the three reward kinds', () => {
    expect(validateTaskReward({ type: 'credit', amount_myr: 5.5 })).toEqual({
      type: 'credit',
      amount_myr: 5.5,
    });
    expect(validateTaskReward({ type: 'pack', pack_id: 'bronze' })).toEqual({
      type: 'pack',
      pack_id: 'bronze',
    });
    expect(
      validateTaskReward({ type: 'card', card_handle: 'pikachu-psa9' }),
    ).toEqual({ type: 'card', card_handle: 'pikachu-psa9' });
  });

  it('rejects bad credit amounts (zero, sub-sen, over cap) — float-safely', () => {
    expect(() =>
      validateTaskReward({ type: 'credit', amount_myr: 0 }),
    ).toThrow();
    expect(() =>
      validateTaskReward({ type: 'credit', amount_myr: 1.005 }),
    ).toThrow();
    expect(() =>
      validateTaskReward({ type: 'credit', amount_myr: 10_001 }),
    ).toThrow();
    // 1.15 * 100 float hazard must be VALID money.
    expect(validateTaskReward({ type: 'credit', amount_myr: 1.15 })).toEqual({
      type: 'credit',
      amount_myr: 1.15,
    });
  });
});

describe('taskProgress', () => {
  it('checkin_days counts the week', () => {
    expect(
      taskProgress(
        { type: 'checkin_days', days: 5 },
        facts({ checkinDaysThisWeek: 3 }),
      ),
    ).toEqual({ current: 3, target: 5, completed: false });
  });

  it('rip_count with a pack filter reads the per-pack map', () => {
    const f = facts({
      ripsThisWeek: 7,
      ripsThisWeekByPack: new Map([['bronze', 2]]),
    });
    expect(
      taskProgress({ type: 'rip_count', count: 3, pack_id: 'bronze' }, f),
    ).toEqual({ current: 2, target: 3, completed: false });
    expect(
      taskProgress({ type: 'rip_count', count: 5, pack_id: null }, f).completed,
    ).toBe(true);
  });

  it('achievements read lifetime facts and clamp the display current', () => {
    expect(
      taskProgress(
        { type: 'vault_count', count: 10 },
        facts({ vaultCount: 25 }),
      ),
    ).toEqual({ current: 10, target: 10, completed: true });
    expect(
      taskProgress({ type: 'reach_level', level: 20 }, facts({ vipLevel: 12 })),
    ).toEqual({ current: 12, target: 20, completed: false });
    expect(
      taskProgress(
        { type: 'vault_pixel_count', count: 3 },
        facts({ vaultPixelCount: 3 }),
      ).completed,
    ).toBe(true);
  });
});
