import fixtures from './fixtures/humanized-desktop-v0274.json';
import {
  createHumanizedStates,
  rememberHumanizedAssignments,
  planHumanized,
  recordHumanizedCycle,
  type HumanizedState,
} from '../automation-humanized';

describe('desktop 0.2.74 Humanized behavior parity', () => {
  it('keeps omitted identities through intervening selections without retaining runtime timers', () => {
    const full = createHumanizedStates(
      Object.keys(fixtures.assignments),
      'global',
    );
    const saved = rememberHumanizedAssignments([], full);
    const subset = createHumanizedStates(['profile-2'], 'global', saved);
    const remembered = rememberHumanizedAssignments(saved, subset);
    const later = createHumanizedStates(
      ['profile-2', 'profile-1'],
      'global',
      remembered,
    );
    expect(
      later.find((state) => state.profileId === 'profile-1'),
    ).toMatchObject(fixtures.assignments['profile-1']);
    expect(remembered[0]).not.toHaveProperty('nextDrawAt');
  });

  it.each([-60000, 86400000])(
    'replans a legacy passive check despite stale draw offset %i on an offline day',
    (offset) => {
      const entry = fixtures.cases.find(
        (row) =>
          row.state.profileId === 'parity-heavy-usw' &&
          row.expected.reason.startsWith('Offline day'),
      )!;
      const state = {
        ...entry.state,
        nextDrawAt: entry.now + offset,
        waitReason: 'Between activity sessions',
      } as HumanizedState;
      expect(planHumanized(state, entry.now, () => 0.5)).toMatchObject({
        ready: false,
        reason: 'Offline day — next planned activity',
      });
      expect(state.timerKind).toBe('SESSION_BREAK_END');
    },
  );
  it('matches all 80 reference persona, region and schedule-shift assignments', () => {
    const states = createHumanizedStates(
      Object.keys(fixtures.assignments),
      'global',
    );
    for (const state of states)
      expect(state).toMatchObject(
        fixtures.assignments[
          state.profileId as keyof typeof fixtures.assignments
        ],
      );
    const counts = Object.fromEntries(
      ['heavy', 'active', 'normal', 'casual', 'rare'].map((persona) => [
        persona,
        states.filter((state) => state.persona === persona).length,
      ]),
    );
    expect(counts).toEqual({
      heavy: 12,
      active: 24,
      normal: 28,
      casual: 12,
      rare: 4,
    });
    const restarted = createHumanizedStates(
      states.slice(10).map((s) => s.profileId),
      'global',
      states,
    );
    for (const state of restarted)
      expect(state).toMatchObject(
        fixtures.assignments[
          state.profileId as keyof typeof fixtures.assignments
        ],
      );
  });
  it.each(fixtures.cases.map((entry, i) => [i, entry] as const))(
    'matches reference decision %i',
    (_i, entry) => {
      const state = structuredClone(entry.state) as HumanizedState;
      let index = 0;
      const random = () => entry.random[index++ % entry.random.length];
      if (entry.afterCycle)
        recordHumanizedCycle(state, entry.now, random, {
          spend: entry.spend,
          value: entry.value,
        });
      expect(planHumanized(state, entry.now, random)).toMatchObject({
        delayMs: entry.expected.delayMs,
        reason: entry.expected.reason,
        ready: false,
      });
      expect(state).toMatchObject({
        behaviorState: entry.expected.behaviorState,
        dayType: entry.expected.dayType,
      });
    },
  );
});
