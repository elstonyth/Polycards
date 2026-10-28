import { describe, expect, it } from 'vitest';
import { importAutomationSettings } from './settings-import';

const defaults = {
  timingMode: 'fixed' as const,
  fixedIntervalSeconds: 2,
  randomMinSeconds: 2,
  randomMaxSeconds: 5,
  maxCyclesPerProfile: 1,
  maxTotalSpend: 8000,
  humanizedRegion: 'mysg' as const,
  humanizedTestClock: false,
  rankTargets: [],
};

describe('Desktop Automation settings import', () => {
  it('converts native units and ignores browser destinations and credentials', () => {
    const result = importAutomationSettings(
      JSON.stringify({
        timing_mode: 'fixed',
        fixed_value: 2,
        fixed_unit: 'Minutes',
        fixed_cycle_mode: 'LIMITED',
        fixed_cycle_limit: 3,
        api_url: 'http://untrusted.invalid',
        password: 'do-not-copy',
        selected_ids: ['live-account'],
      }),
      defaults,
    );
    expect(result.config).toEqual({
      ...defaults,
      fixedIntervalSeconds: 120,
      maxCyclesPerProfile: 3,
    });
    expect(JSON.stringify(result)).not.toContain('do-not-copy');
    expect(JSON.stringify(result)).not.toContain('untrusted.invalid');
  });

  it('migrates legacy random timing without silently changing unlimited execution', () => {
    expect(
      importAutomationSettings(
        JSON.stringify({
          timing_mode: 'legacy',
          draw_min: 10,
          draw_max: 30,
          draw_cycle_limit: 2,
        }),
        defaults,
      ).config,
    ).toMatchObject({
      timingMode: 'random',
      randomMinSeconds: 10,
      randomMaxSeconds: 30,
      maxCyclesPerProfile: 2,
    });
    expect(() =>
      importAutomationSettings(
        JSON.stringify({ timing_mode: 'fixed', fixed_cycle_mode: 'UNLIMITED' }),
        defaults,
      ),
    ).toThrow('unlimited');
    expect(() =>
      importAutomationSettings(
        JSON.stringify({ timing_mode: 'random', draw_cycle_limit: 0 }),
        defaults,
      ),
    ).toThrow('unlimited');
  });

  it('validates malformed, excessive and reversed timing without modifying current settings', () => {
    for (const value of [
      '[]',
      '{',
      JSON.stringify({
        timing_mode: 'random',
        random_min_value: 2,
        random_min_unit: 'Minutes',
        random_max_value: 30,
        random_max_unit: 'Seconds',
      }),
      JSON.stringify({
        timing_mode: 'fixed',
        fixed_value: '',
        fixed_unit: 'Seconds',
      }),
      JSON.stringify({ timingMode: 'fixed', maxCyclesPerProfile: 11 }),
    ]) {
      expect(() => importAutomationSettings(value, defaults)).toThrow();
    }
    expect(defaults.fixedIntervalSeconds).toBe(2);
  });

  it('round-trips an API config and reports a retained sandbox bound for humanized settings', () => {
    expect(
      importAutomationSettings(JSON.stringify({ config: defaults }), defaults)
        .config,
    ).toEqual(defaults);
    expect(
      importAutomationSettings(
        '{"timing_mode":"humanized"}',
        defaults,
      ).notes.join(' '),
    ).toContain('Kept the visible sandbox limit');
  });

  it('requires an explicit test clock in imported settings instead of inheriting it', () => {
    const current = {
      ...defaults,
      timingMode: 'humanized' as const,
      humanizedTestClock: true,
    };
    expect(
      importAutomationSettings('{"timing_mode":"humanized"}', current).config
        .humanizedTestClock,
    ).toBe(false);
    const imported = importAutomationSettings(
      '{"timingMode":"humanized","humanizedTestClock":true}',
      defaults,
    );
    expect(imported.config.humanizedTestClock).toBe(true);
    expect(imported.notes.join(' ')).toContain(
      'Accelerated sandbox test clock',
    );
    expect(() =>
      importAutomationSettings(
        '{"timingMode":"humanized","humanizedTestClock":"true"}',
        defaults,
      ),
    ).toThrow();
  });

  it('rejects invalid explicit API spend caps and explains the desktop disabled-cap conversion', () => {
    for (const maxTotalSpend of [0, -1, 10.001]) {
      expect(() =>
        importAutomationSettings(
          JSON.stringify({ timingMode: 'fixed', maxTotalSpend }),
          defaults,
        ),
      ).toThrow();
    }
    const result = importAutomationSettings(
      '{"timing_mode":"fixed","qa_max_spend_per_run_session":0}',
      defaults,
    );
    expect(result.config.maxTotalSpend).toBe(8000);
    expect(result.notes.join(' ')).toContain('Kept the visible sandbox cap');
  });

  it('imports exact sandbox rank settings and rejects live desktop modes', () => {
    const target = {
      profileId: 'account-1',
      period: 'weekly',
      mode: 'shadow',
      goal: 'reach',
      targetRank: 3,
      secureBufferMyr: 20,
      threatBufferMyr: 5,
      maxCycles: 3,
      maxSpendMyr: 30,
      maxDurationMinutes: 15,
    };
    expect(
      importAutomationSettings(
        JSON.stringify({ ...defaults, rankTargets: [target] }),
        defaults,
      ).config.rankTargets,
    ).toEqual([target]);
    expect(() =>
      importAutomationSettings(
        JSON.stringify({
          ...defaults,
          rankTargets: [{ ...target, mode: 'LIVE' }],
        }),
        defaults,
      ),
    ).toThrow();
    expect(
      importAutomationSettings(
        JSON.stringify({
          ...defaults,
          rank_targets: [{ account_id: 'production' }],
        }),
        defaults,
      ).config.rankTargets,
    ).toEqual([]);
  });
});
