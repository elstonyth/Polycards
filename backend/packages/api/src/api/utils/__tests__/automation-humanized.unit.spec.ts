import {
  createHumanizedState,
  planHumanized,
  recordHumanizedCycle,
  type HumanizedState,
} from '../automation-humanized';

const random = () => 0.5;
const start = Date.parse('2026-10-18T04:00:00Z');

function ready(state: HumanizedState, initial = start) {
  let now = initial;
  for (let i = 0; i < 100; i++) {
    const result = planHumanized(state, now, random);
    if (result.ready) return now;
    expect(result.delayMs).toBeGreaterThan(0);
    now += result.delayMs;
  }
  throw new Error('No humanized session within bounded search');
}

describe('adapted humanized API QA schedule', () => {
  it('assigns stable personas and global regions with JSON-serializable state', () => {
    const states = Array.from({ length: 80 }, (_, i) =>
      createHumanizedState(`profile-${i}`, 'global'),
    );
    expect(states).toEqual(
      Array.from({ length: 80 }, (_, i) =>
        createHumanizedState(`profile-${i}`, 'global'),
      ),
    );
    expect(new Set(states.map((state) => state.persona)).size).toBe(5);
    expect(new Set(states.map((state) => state.region)).size).toBe(7);
    expect(JSON.parse(JSON.stringify(states))).toEqual(states);
    expect(createHumanizedState('profile-1', 'mysg').region).toBe('mysg');
  });

  it('holds sleeping accounts and recalculates eligibility when the timer ends', () => {
    const state = createHumanizedState('sleep', 'mysg');
    const now = Date.parse('2026-10-18T00:00:00Z'); // 08:00 MYT
    const result = planHumanized(state, now, random);
    expect(result).toMatchObject({ ready: false, delayMs: 4 * 3600_000 });
    expect(result.reason).toContain('Sleeping');
    const wake = planHumanized(state, now + result.delayMs, random);
    expect(wake.ready).toBe(false);
    expect(wake.reason).not.toContain('Sleeping');
  });

  it('requires a warmup and preserves its remaining time instead of rerolling it', () => {
    const state = createHumanizedState('warmup', 'mysg');
    const due = ready(state);
    expect(state.sessionDraws).toBe(0);
    expect(state.nextDrawAt).toBe(due);
    expect(planHumanized(state, due - 1000, () => 0.01)).toMatchObject({
      ready: false,
      delayMs: 1000,
      reason: 'Thinking before first draw',
    });
    expect(
      planHumanized(
        JSON.parse(JSON.stringify(state)) as HumanizedState,
        due,
        random,
      ).ready,
    ).toBe(true);
  });

  it('waits after each completed cycle and forces a break at the session cap', () => {
    const state = {
      ...createHumanizedState('cycle', 'mysg'),
      persona: 'heavy' as const,
    };
    const now = ready(state);
    const delay = recordHumanizedCycle(state, now, random);
    expect(state.sessionDraws).toBe(1);
    expect(delay).toBeGreaterThanOrEqual(120_000);
    expect(planHumanized(state, now, random).ready).toBe(false);
    state.sessionDraws = 9;
    expect(planHumanized(state, now, random)).toMatchObject({
      ready: false,
      reason: 'Session break',
    });
  });

  it('rechecks sleep even when a previously scheduled draw is overdue', () => {
    const state = createHumanizedState('overdue', 'mysg');
    ready(state);
    state.nextDrawAt = 0;
    expect(
      planHumanized(state, Date.parse('2026-10-20T00:00:00Z'), random),
    ).toMatchObject({ ready: false });
  });

  it('uses regional DST when calculating the end of sleep', () => {
    const state = {
      ...createHumanizedState('dst', 'global'),
      region: 'use' as const,
    };
    expect(
      planHumanized(state, Date.parse('2026-07-01T06:00:00Z'), random).delayMs,
    ).toBe(5.5 * 3600_000);
    expect(
      planHumanized(state, Date.parse('2026-01-01T06:00:00Z'), random).delayMs,
    ).toBe(6.5 * 3600_000);
  });

  it('rejects invalid clocks and random values', () => {
    const state = createHumanizedState('invalid', 'mysg');
    expect(() => planHumanized(state, NaN, random)).toThrow('clock');
    const now = ready(state);
    expect(() => recordHumanizedCycle(state, now, () => NaN)).toThrow('random');
  });
});
