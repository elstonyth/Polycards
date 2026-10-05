import {
  taskIsLive,
  taskPeriodKey,
  taskProgress,
  validateTaskRequirement,
  validateTaskReward,
  type PeriodFacts,
  type TaskFacts,
} from '../tasks';

const period = (over: Partial<PeriodFacts> = {}): PeriodFacts => ({
  checkinDays: 0,
  rips: 0,
  ripsByPack: new Map(),
  pixelPulls: 0,
  pixelPullsById: new Map(),
  ...over,
});

const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  day: period(),
  week: period(),
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
    >[1];
    expect(taskProgress('weekly', unknown, facts())).toEqual({
      current: 0,
      target: 0,
      completed: false,
    });
  });

  it('checkin_days counts the week', () => {
    expect(
      taskProgress(
        'weekly',
        { type: 'checkin_days', days: 5 },
        facts({ week: period({ checkinDays: 3 }) }),
      ),
    ).toEqual({ current: 3, target: 5, completed: false });
  });

  it('rip_count with a pack filter reads the per-pack map', () => {
    const f = facts({
      week: period({ rips: 7, ripsByPack: new Map([['bronze', 2]]) }),
    });
    expect(
      taskProgress(
        'weekly',
        { type: 'rip_count', count: 3, pack_id: 'bronze' },
        f,
      ),
    ).toEqual({ current: 2, target: 3, completed: false });
    expect(
      taskProgress('weekly', { type: 'rip_count', count: 5, pack_id: null }, f)
        .completed,
    ).toBe(true);
  });

  it('achievements read lifetime facts and clamp the display current', () => {
    expect(
      taskProgress(
        'achievement',
        { type: 'vault_count', count: 10 },
        facts({ vaultCount: 25 }),
      ),
    ).toEqual({ current: 10, target: 10, completed: true });
    expect(
      taskProgress(
        'achievement',
        { type: 'reach_level', level: 20 },
        facts({ vipLevel: 12 }),
      ),
    ).toEqual({ current: 12, target: 20, completed: false });
    expect(
      taskProgress(
        'achievement',
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
        'achievement',
        { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: 'px_pikachu' },
        f,
      ),
    ).toEqual({ current: 2, target: 3, completed: false });
    expect(
      taskProgress(
        'achievement',
        { type: 'vault_pixel_count', count: 3, pixel_pokemon_id: 'px_mew' },
        f,
      ).completed,
    ).toBe(true);
    // A species the customer owns none of must read 0, never the total.
    expect(
      taskProgress(
        'achievement',
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

describe('daily cadence (2026-10-06)', () => {
  it('daily and weekly share the repeating goal family', () => {
    for (const kind of ['daily', 'weekly'] as const) {
      expect(
        validateTaskRequirement(kind, { type: 'rip_count', count: 2 }),
      ).toEqual({ type: 'rip_count', count: 2, pack_id: null });
      expect(
        validateTaskRequirement(kind, {
          type: 'vault_pixel_count',
          count: 1,
          pixel_pokemon_id: 'px_pikachu',
        }),
      ).toEqual({
        type: 'vault_pixel_count',
        count: 1,
        pixel_pokemon_id: 'px_pikachu',
      });
      // Lifetime ratchets can never repeat: a player who already met one
      // would re-claim it every period.
      expect(() =>
        validateTaskRequirement(kind, { type: 'reach_level', level: 5 }),
      ).toThrow(new RegExp(kind));
      expect(() =>
        validateTaskRequirement(kind, { type: 'vault_count', count: 5 }),
      ).toThrow(new RegExp(kind));
    }
  });

  it('a daily check-in task counts today only — days must be 1', () => {
    expect(
      validateTaskRequirement('daily', { type: 'checkin_days', days: 1 }),
    ).toEqual({ type: 'checkin_days', days: 1 });
    expect(() =>
      validateTaskRequirement('daily', { type: 'checkin_days', days: 2 }),
    ).toThrow(/days must be 1/);
  });

  it('an unknown kind is refused, not treated as weekly', () => {
    expect(() =>
      validateTaskRequirement('monthly' as never, {
        type: 'rip_count',
        count: 1,
      }),
    ).toThrow(/kind/i);
  });

  it('daily goals read the day window, weekly goals the week window', () => {
    const f = facts({
      day: period({
        checkinDays: 1,
        rips: 1,
        ripsByPack: new Map([['bronze', 1]]),
        pixelPulls: 1,
        pixelPullsById: new Map([['px_pikachu', 1]]),
      }),
      week: period({
        checkinDays: 4,
        rips: 6,
        ripsByPack: new Map([['bronze', 5]]),
        pixelPulls: 3,
        pixelPullsById: new Map([['px_pikachu', 2]]),
      }),
      // Lifetime pixel pulls must NOT leak into a periodic task.
      vaultPixelCount: 40,
      vaultPixelCountById: new Map([['px_pikachu', 30]]),
    });
    const rip3 = { type: 'rip_count' as const, count: 3, pack_id: null };
    expect(taskProgress('daily', rip3, f)).toEqual({
      current: 1,
      target: 3,
      completed: false,
    });
    expect(taskProgress('weekly', rip3, f).completed).toBe(true);
    expect(
      taskProgress('daily', { type: 'checkin_days', days: 1 }, f).completed,
    ).toBe(true);
    const pika = {
      type: 'vault_pixel_count' as const,
      count: 2,
      pixel_pokemon_id: 'px_pikachu',
    };
    expect(taskProgress('daily', pika, f).current).toBe(1);
    expect(taskProgress('weekly', pika, f)).toEqual({
      current: 2,
      target: 2,
      completed: true,
    });
    // Achievements keep the lifetime count.
    expect(taskProgress('achievement', pika, f).current).toBe(2);
    expect(
      taskProgress(
        'weekly',
        { type: 'vault_pixel_count', count: 5, pixel_pokemon_id: null },
        f,
      ).current,
    ).toBe(3);
  });

  it('nothing from today counts before the first check-in of the day', () => {
    expect(
      taskProgress(
        'daily',
        { type: 'checkin_days', days: 1 },
        facts({ week: period({ checkinDays: 6 }) }),
      ),
    ).toEqual({ current: 0, target: 1, completed: false });
  });
});

describe('taskPeriodKey', () => {
  const at = { weekStartIso: '2026-10-05', dayIso: '2026-10-07' };
  it('one claim per day / per task week / ever', () => {
    expect(taskPeriodKey('daily', at)).toBe('2026-10-07');
    expect(taskPeriodKey('weekly', at)).toBe('2026-10-05');
    expect(taskPeriodKey('achievement', at)).toBe('');
  });
});
