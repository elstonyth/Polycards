import {
  advanceSandbox,
  applySandboxAction,
  createSandboxState,
  sandboxSnapshot,
} from '../automation-sandbox-engine';
import { DEFAULT_AUTOMATION_CONFIG } from '../automation-config';
import type { AutomationConfig } from '../automation-types';

const NOW = Date.parse('2026-10-18T07:00:00Z');
function ready(count = 1, config: Partial<AutomationConfig> = {}) {
  const state = createSandboxState(NOW);
  applySandboxAction(state, { action: 'create_profiles', count }, NOW);
  applySandboxAction(
    state,
    {
      action: 'run',
      config: { ...DEFAULT_AUTOMATION_CONFIG, ...config },
      profileIds: state.selectedProfileIds,
    },
    NOW,
  );
  return state;
}

describe('cloud sandbox execution', () => {
  it('enforces target duration even while a Humanized persona sleeps', () => {
    const state = ready(1, {
      timingMode: 'humanized',
      rankTargets: [
        {
          profileId: 'sandbox_001',
          period: 'weekly',
          mode: 'test',
          goal: 'reach',
          targetRank: 1,
          secureBufferMyr: 0,
          threatBufferMyr: 0,
          maxCycles: 3,
          maxSpendMyr: 30,
          maxDurationMinutes: 1,
        },
      ],
    });
    const now = Date.parse('2026-10-19T00:00:00Z');
    state.results[0].rank!.expiresAt = now + 60000;
    advanceSandbox(state, now, () => 0.5);
    expect(state.nextRunAt).toBe(now + 60000);
    advanceSandbox(state, now + 60000, () => 0.5);
    expect(state.status).toBe('completed');
    expect(state.spentCents).toBe(0);
    expect(state.results[0].rank?.status.state).toBe('limited');
  });
  it('settles all 80 synthetic wallets once, including independent bonus checks', () => {
    const state = ready(80);
    applySandboxAction(state, { action: 'stop' }, NOW);
    applySandboxAction(
      state,
      { action: 'bonus', profileIds: state.selectedProfileIds, amount: 15.25 },
      NOW,
    );
    applySandboxAction(
      state,
      {
        action: 'run',
        config: state.config,
        profileIds: state.selectedProfileIds,
      },
      NOW,
    );
    for (let index = 0; index < 80; index++) {
      expect(advanceSandbox(state, NOW + index * 2000, () => 0.9)).toBe(true);
      expect(advanceSandbox(state, NOW + index * 2000, () => 0.9)).toBe(false);
    }
    expect(state.status).toBe('completed');
    expect(state.completedCycles).toBe(80);
    expect(state.spentCents).toBe(80_000);
    for (const profile of state.profiles) {
      expect(profile.balanceCents).toBe(14_525);
      expect(profile.bonusCents).toBe(525);
      expect(profile.allTimePulls).toBe(1);
    }
    for (const result of state.results) {
      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]).toMatchObject({
        startingCents: 11_525,
        endingCents: 14_525,
        expectedCents: 14_525,
        differenceCents: 0,
        startingBonusCents: 1525,
        endingBonusCents: 525,
        expectedBonusCents: 525,
        bonusDifferenceCents: 0,
      });
    }
  });

  it('enforces fixed and random waits and never catches up missed ticks in a burst', () => {
    const fixed = ready(1, { fixedIntervalSeconds: 7, maxCyclesPerProfile: 3 });
    advanceSandbox(fixed, NOW, () => 0);
    expect(advanceSandbox(fixed, NOW + 6999)).toBe(false);
    advanceSandbox(fixed, NOW + 60_000, () => 0);
    expect(fixed.completedCycles).toBe(2);
    expect(fixed.nextRunAt).toBe(NOW + 67_000);
    const random = ready(1, {
      timingMode: 'random',
      randomMinSeconds: 3,
      randomMaxSeconds: 8,
      maxCyclesPerProfile: 2,
    });
    advanceSandbox(random, NOW, () => 0.999);
    expect(random.nextRunAt).toBe(NOW + 8000);
  });

  it('preserves paused/restored state and stops without another cycle', () => {
    let state = ready(2, { maxCyclesPerProfile: 2 });
    advanceSandbox(state, NOW, () => 0.5);
    applySandboxAction(state, { action: 'pause' }, NOW + 1);
    state = JSON.parse(JSON.stringify(state));
    expect(advanceSandbox(state, NOW + 100_000)).toBe(false);
    expect(() =>
      applySandboxAction(
        state,
        {
          action: 'run',
          config: state.config,
          profileIds: state.selectedProfileIds,
        },
        NOW,
      ),
    ).toThrow('Stop');
    applySandboxAction(state, { action: 'resume' }, NOW + 100_000);
    expect(advanceSandbox(state, NOW + 101_999)).toBe(false);
    advanceSandbox(state, NOW + 102_000, () => 0.5);
    applySandboxAction(state, { action: 'stop' }, NOW + 102_001);
    const before = structuredClone(state);
    expect(advanceSandbox(state, NOW + 200_000)).toBe(false);
    expect(state).toEqual(before);
    expect(state.completedCycles).toBe(2);
  });

  it('advances Humanized waiting only in explicit accelerated mode', () => {
    const state = ready(80, {
      timingMode: 'humanized',
      humanizedTestClock: true,
    });
    for (let index = 0; index < 80; index++)
      advanceSandbox(state, NOW + index * 2000, () => 0.5);
    expect(state.completedCycles).toBe(80);
    expect(state.status).toBe('completed');
    expect(state.clockAt).toBeGreaterThan(NOW);
    const sleeping = ready(1, { timingMode: 'humanized' });
    const sleepTime = Date.parse('2026-10-19T00:00:00Z'); // 08:00 Malaysia.
    advanceSandbox(sleeping, sleepTime, () => 0.5);
    expect(sleeping.completedCycles).toBe(0);
    expect(sleeping.results[0].waitReason).toContain('Sleeping');
    expect(sleeping.nextRunAt).toBeGreaterThan(sleepTime);
  });

  it('honors batch limits and reports an unfunded profile without negative balances', () => {
    const capped = ready(2, { maxCyclesPerProfile: 3, maxTotalSpend: 10 });
    advanceSandbox(capped, NOW, () => 0.5);
    advanceSandbox(capped, NOW + 2000, () => 0.5);
    expect(capped.spentCents).toBe(1000);
    expect(capped.status).toBe('completed');
    const empty = ready();
    empty.profiles[0].balanceCents = 0;
    advanceSandbox(empty, NOW);
    expect(empty.status).toBe('failed');
    expect(empty.profiles[0].balanceCents).toBe(0);
  });

  it('keeps preview read-only and targets only the synthetic leaderboard', () => {
    const target = {
      profileId: 'sandbox_001',
      period: 'weekly' as const,
      mode: 'shadow' as const,
      goal: 'reach' as const,
      targetRank: 10,
      secureBufferMyr: 0,
      threatBufferMyr: 0,
      maxCycles: 3,
      maxSpendMyr: 30,
      maxDurationMinutes: 5,
    };
    const preview = ready(1, { rankTargets: [target] });
    advanceSandbox(preview, NOW);
    expect(preview.status).toBe('completed');
    expect(preview.spentCents).toBe(0);
    expect(preview.results[0].rank?.status.wouldDraw).toBe(true);
    const test = ready(1, {
      maxCyclesPerProfile: 3,
      rankTargets: [{ ...target, mode: 'test' }],
    });
    advanceSandbox(test, NOW, () => 0.9);
    advanceSandbox(test, NOW + 2000, () => 0.9);
    advanceSandbox(test, NOW + 4000, () => 0.9);
    expect(test.status).toBe('completed');
    expect(test.completedCycles).toBe(1);
    expect(test.results[0].rank?.status.state).toBe('secured');
    expect(
      sandboxSnapshot(test).leaderboards.weekly.every((entry) =>
        /^(sandbox_|fixture_rival_)/.test(entry.profileId),
      ),
    ).toBe(true);
  });

  it('rejects original IDs, credentials, unbounded config, duplicate IDs and oversized grants', () => {
    const state = createSandboxState(NOW);
    for (const input of [
      { action: 'create_profiles', count: 81 },
      { action: 'create_profiles', count: 1, password: 'secret' },
      { action: '__proto__' },
    ]) {
      expect(() => applySandboxAction(state, input, NOW)).toThrow();
    }
    applySandboxAction(state, { action: 'create_profiles', count: 1 }, NOW);
    for (const profileIds of [
      ['cus_original'],
      ['sandbox_001', 'sandbox_001'],
    ]) {
      expect(() =>
        applySandboxAction(
          state,
          { action: 'run', config: {}, profileIds },
          NOW,
        ),
      ).toThrow();
    }
    expect(() =>
      applySandboxAction(
        state,
        { action: 'bonus', amount: 8001, profileIds: state.selectedProfileIds },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      applySandboxAction(
        state,
        {
          action: 'run',
          config: { maxCyclesPerProfile: 0 },
          profileIds: state.selectedProfileIds,
        },
        NOW,
      ),
    ).toThrow();
    expect(state.status).toBe('idle');
    expect(state.completedCycles).toBe(0);
  });
});
