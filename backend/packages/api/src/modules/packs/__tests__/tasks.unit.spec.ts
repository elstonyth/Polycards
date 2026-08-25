import {
  taskIsLive,
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
  vaultPixelCountById: new Map(),
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
  it('an UNKNOWN requirement is never complete (fail closed)', () => {
    // A row written before a union change, or straight into the DB. Without
    // the target > 0 guard this returned completed:true and every customer
    // could claim the reward at zero progress.
    const unknown = { type: 'rip_streak', days: 3 } as unknown as Parameters<
      typeof taskProgress
    >[0];
    expect(taskProgress(unknown, facts())).toEqual({
      current: 0,
      target: 0,
      completed: false,
    });
  });

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

describe('vault_pixel_count with a species', () => {
  it('counts only that Pokémon when one is named', () => {
    const f = facts({
      vaultPixelCount: 9,
      vaultPixelCountById: new Map([
        ['px_pikachu', 2],
        ['px_mew', 7],
      ]),
    });
    expect(
      taskProgress(
        { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: 'px_pikachu' },
        f,
      ),
    ).toEqual({ current: 2, target: 3, completed: false });
    expect(
      taskProgress(
        { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: 'px_mew' },
        f,
      ).completed,
    ).toBe(true);
    // A species the customer owns none of must read 0, never the total.
    expect(
      taskProgress(
        { type: 'vault_pixel_count', count: 1, pixel_pokemon_id: 'px_ghost' },
        f,
      ),
    ).toEqual({ current: 0, target: 1, completed: false });
  });

  it('validates and normalises pixel_pokemon_id', () => {
    expect(
      validateTaskRequirement('achievement', {
        type: 'vault_pixel_count',
        count: 2,
      }),
    ).toEqual({ type: 'vault_pixel_count', count: 2, pixel_pokemon_id: null });
    expect(() =>
      validateTaskRequirement('achievement', {
        type: 'vault_pixel_count',
        count: 2,
        pixel_pokemon_id: 7,
      }),
    ).toThrow(/pixel_pokemon_id/);
  });
});

describe('taskIsLive', () => {
  const at = new Date('2026-08-25T12:00:00Z');

  it('an unscheduled task is always live', () => {
    expect(taskIsLive({}, at)).toBe(true);
    expect(taskIsLive({ starts_at: null, ends_at: null }, at)).toBe(true);
  });

  it('is closed before the start and at/after the end', () => {
    expect(taskIsLive({ starts_at: '2026-08-26T00:00:00Z' }, at)).toBe(false);
    expect(taskIsLive({ starts_at: '2026-08-24T00:00:00Z' }, at)).toBe(true);
    // End is EXCLUSIVE — the instant it hits, the task is over.
    expect(taskIsLive({ ends_at: '2026-08-25T12:00:00Z' }, at)).toBe(false);
    expect(taskIsLive({ ends_at: '2026-08-25T12:00:01Z' }, at)).toBe(true);
  });
});
