import { describe, expect, it } from 'vitest';
import type {
  LiveCycle,
  LiveSnapshot,
} from '../../../../../packages/api/src/api/utils/automation-live-types';
import { getLiveAccountActivity } from './live-account-activity';
import { refreshLiveRankGoals } from '../../../../../packages/api/src/api/utils/automation-live-rank';

const now = Date.UTC(2026, 9, 18, 14);
const cycle: LiveCycle = {
  id: 'cycle-a',
  customerId: 'a',
  startedAt: now - 1000,
  finishedAt: now,
  error: null,
  pullId: 'pull-a',
  differenceCents: 0,
  bonusDifferenceCents: 0,
};

function snapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    version: 1,
    mode: 'live',
    status: 'running',
    config: {
      packSlug: 'paid-pack',
      customerIds: ['a', 'b'],
      intervalSeconds: 5,
      maxCyclesPerAccount: 1,
      timingMode: 'humanized',
      humanizedRegion: 'mysg',
    },
    runId: 'run',
    packPriceCents: 4500,
    spentCents: 0,
    nextRunAt: now + 60000,
    pending: null,
    cycles: [],
    error: null,
    packs: [],
    accounts: [],
    schedules: [
      {
        customerId: 'a',
        humanized: {
          profileId: 'a',
          persona: 'normal',
          region: 'mysg',
          label: 'Normal',
          sessionKey: null,
          sessionDraws: 0,
          nextDrawAt: null,
        },
        nextRunAt: now + 60000,
        waitReason: 'Between activity sessions',
      },
    ],
    ...overrides,
  };
}

describe('Live account activity', () => {
  it('shows goal results separately from cycle completion; accounts without goals draw ordinarily', () => {
    const state = snapshot({ cycles: [cycle], schedules: [] });
    state.config!.rankTargets = [
      { customerId: 'a', period: 'weekly', targetRank: 1 },
    ];
    refreshLiveRankGoals(state, [], now);
    expect(getLiveAccountActivity(state, 'b', true, now).label).toBe('Pending');
    state.cycles = [cycle, { ...cycle, id: 'cycle-b', customerId: 'b' }];
    expect(getLiveAccountActivity(state, 'b', true, now).label).toBe(
      'Completed',
    );
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Rank data unavailable',
      settledCycles: 1,
    });
    state.rankGoals![0].done = true;
    state.rankGoals![0].status.state = 'limited';
    expect(getLiveAccountActivity(state, 'a', true, now).label).toBe(
      'Goal limit reached',
    );
    state.rankGoals![0].status.state = 'secured';
    expect(getLiveAccountActivity(state, 'a', true, now).label).toBe(
      'Rank goal reached',
    );
  });

  it('keeps paused and failed run precedence over a waiting rank goal', () => {
    const state = snapshot();
    state.config!.rankTargets = [
      { customerId: 'a', period: 'weekly', targetRank: 1 },
    ];
    refreshLiveRankGoals(state, [], now);
    state.status = 'paused';
    expect(getLiveAccountActivity(state, 'a', true, now).label).toBe('Paused');
    state.status = 'failed';
    expect(getLiveAccountActivity(state, 'a', true, now).label).toBe('Blocked');
  });

  it('puts a ready goal account first in the fixed draw queue', () => {
    const state = snapshot({ schedules: [] });
    state.config!.timingMode = 'fixed';
    state.config!.rankTargets = [
      { customerId: 'b', period: 'weekly', targetRank: 1 },
    ];
    refreshLiveRankGoals(
      state,
      [
        {
          customerId: 'b',
          periodKey: 'week',
          observedAt: now,
          ownPulls: 0,
          ownValueMyr: 0,
          entries: [{ customerId: 'external', pulls: 1, valueMyr: 100 }],
        },
      ],
      now,
    );
    expect(getLiveAccountActivity(state, 'b', true, now)).toMatchObject({
      label: 'Waiting',
      reason: 'Waiting for the configured draw interval.',
    });
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Pending',
      reason: 'Waiting for earlier accounts to finish.',
    });
  });
  it.each([
    'Between activity sessions',
    'Session break',
    'Sleeping · Malaysia / Singapore',
  ])('shows resting reason and next check for %s', (waitReason) => {
    const state = snapshot();
    state.schedules![0].waitReason = waitReason;
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Resting',
      reason: waitReason,
      nextCheckAt: now + 60000,
      settledCycles: 0,
    });
  });

  it.each(['Thinking before first draw', 'Persona interval'])(
    'distinguishes waiting inside a session from resting for %s',
    (waitReason) => {
      const state = snapshot();
      state.schedules![0].waitReason = waitReason;
      expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
        label: 'Waiting',
        reason: waitReason,
        nextCheckAt: now + 60000,
      });
    },
  );

  it.each(['OFFLINE_END', 'SESSION_BREAK_END', 'SHORT_BREAK_END'] as const)(
    'shows persisted desktop %s timers as resting',
    (timerKind) => {
      const state = snapshot();
      state.schedules![0].humanized.timerKind = timerKind;
      state.schedules![0].waitReason = 'Short interruption / break';
      expect(getLiveAccountActivity(state, 'a', true, now).label).toBe(
        'Resting',
      );
    },
  );

  it('shows desktop thinking state explicitly', () => {
    const state = snapshot();
    state.schedules![0].humanized.timerKind = 'DRAW';
    state.schedules![0].humanized.behaviorState = 'THINKING';
    expect(getLiveAccountActivity(state, 'a', true, now).label).toBe(
      'Thinking',
    );
  });

  it('shows overdue checks as pending instead of continuing to claim account is sleeping', () => {
    const state = snapshot();
    state.schedules![0].nextRunAt = now;
    state.schedules![0].waitReason = 'Sleeping · Malaysia / Singapore';
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Pending',
      nextCheckAt: now,
    });
  });

  it('distinguishes opening a pack from settling its returned card', () => {
    const pending = { ...cycle, finishedAt: null, pullId: undefined };
    expect(
      getLiveAccountActivity(snapshot({ pending }), 'a', true, now),
    ).toMatchObject({ label: 'Drawing', nextCheckAt: null });
    expect(
      getLiveAccountActivity(
        snapshot({ pending: { ...pending, pullId: 'pull-a' } }),
        'a',
        true,
        now,
      ),
    ).toMatchObject({ label: 'Settling', nextCheckAt: null });
  });

  it('marks only reconciled finished cycles as completed, overriding old wait schedules', () => {
    expect(
      getLiveAccountActivity(snapshot({ cycles: [cycle] }), 'a', true, now),
    ).toMatchObject({
      label: 'Completed',
      settledCycles: 1,
      nextCheckAt: null,
    });
    expect(
      getLiveAccountActivity(
        snapshot({ cycles: [{ ...cycle, error: 'Buyback failed' }] }),
        'a',
        true,
        now,
      ),
    ).toMatchObject({
      label: 'Failed',
      settledCycles: 0,
      reason: 'Buyback failed',
    });
    expect(
      getLiveAccountActivity(
        snapshot({ cycles: [{ ...cycle, bonusDifferenceCents: 1 }] }),
        'a',
        true,
        now,
      ),
    ).toMatchObject({ label: 'Failed', settledCycles: 0 });
  });

  it('keeps multi-cycle accounts waiting until all configured cycles settle', () => {
    const state = snapshot({ cycles: [cycle] });
    state.config!.maxCyclesPerAccount = 2;
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Resting',
      settledCycles: 1,
      nextCheckAt: now + 60000,
    });
  });

  it.each(['paused', 'stopped'] as const)(
    'does not advertise an active next check while run is %s',
    (status) => {
      expect(
        getLiveAccountActivity(snapshot({ status }), 'a', true, now),
      ).toMatchObject({
        label: status === 'paused' ? 'Paused' : 'Stopped',
        nextCheckAt: null,
      });
      expect(
        getLiveAccountActivity(
          snapshot({ status, pending: { ...cycle, finishedAt: null } }),
          'a',
          true,
          now,
        ).label,
      ).toBe('Settling');
    },
  );

  it('shows an interrupted pending draw as failed and other accounts as blocked', () => {
    const state = snapshot({
      status: 'failed',
      error: 'Interrupted draw needs review',
      pending: { ...cycle, finishedAt: null },
    });
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Failed',
      reason: 'Interrupted draw needs review',
      nextCheckAt: null,
    });
    expect(getLiveAccountActivity(state, 'b', true, now)).toMatchObject({
      label: 'Blocked',
      nextCheckAt: null,
    });
  });

  it('does not invent scheduled times for accounts queued behind a fixed interval draw', () => {
    const state = snapshot({ schedules: [] });
    state.config!.timingMode = 'fixed';
    expect(getLiveAccountActivity(state, 'a', true, now)).toMatchObject({
      label: 'Waiting',
      nextCheckAt: now + 60000,
    });
    expect(getLiveAccountActivity(state, 'b', true, now)).toMatchObject({
      label: 'Pending',
      nextCheckAt: null,
    });
    state.cycles = [cycle];
    expect(getLiveAccountActivity(state, 'b', true, now)).toMatchObject({
      label: 'Waiting',
      nextCheckAt: now + 60000,
    });
  });

  it('shows idle and unselected accounts without stale run activity', () => {
    expect(
      getLiveAccountActivity(
        snapshot({ status: 'idle', config: null }),
        'a',
        true,
        now,
      ),
    ).toMatchObject({ label: 'Ready', nextCheckAt: null });
    expect(
      getLiveAccountActivity(
        snapshot({ pending: { ...cycle, finishedAt: null } }),
        'a',
        false,
        now,
      ),
    ).toMatchObject({ label: 'Not selected', nextCheckAt: null });
  });
});
