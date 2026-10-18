import { randomInt, randomUUID } from 'node:crypto';
import {
  DEFAULT_AUTOMATION_CONFIG,
  automationDelayMs,
  validateAutomationConfig,
} from './automation-config';
import {
  createHumanizedState,
  planHumanized,
  recordHumanizedCycle,
} from './automation-humanized';
import {
  createRankRuntime,
  evaluateRank,
  markRankDispatched,
} from './automation-rank';
import type {
  SandboxEntry,
  SandboxProfile,
  SandboxResult,
  SandboxSnapshot,
  SandboxState,
} from './automation-sandbox-types';

const COST = 1000;
const GAP = 2000;
const DONE = new Set(['completed', 'failed', 'stopped']);
const randomFraction = () => randomInt(1_000_000) / 1_000_000;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class SandboxInputError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function weekKey(now: number): string {
  const date = new Date(now + 8 * 3_600_000);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function createSandboxState(now: number): SandboxState {
  if (!Number.isFinite(now)) throw new Error('Invalid sandbox clock.');
  return {
    version: 1,
    mode: 'sandbox',
    status: 'idle',
    config: { ...DEFAULT_AUTOMATION_CONFIG, rankTargets: [] },
    selectedProfileIds: [],
    profiles: [],
    results: [],
    runId: null,
    startedAt: null,
    finishedAt: null,
    nextRunAt: null,
    clockAt: now,
    spentCents: 0,
    completedCycles: 0,
    error: null,
  };
}

function selected(state: SandboxState, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 80 ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !/^sandbox_\d{3}$/.test(id) ||
        !state.profiles.some((profile) => profile.id === id),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new SandboxInputError(
      'Select 1–80 distinct test profiles from this workspace. Original account IDs are not accepted.',
    );
  }
  return [...value] as string[];
}

export function applySandboxAction(
  state: SandboxState,
  input: unknown,
  now: number,
): SandboxState {
  if (!object(input) || typeof input.action !== 'string')
    throw new SandboxInputError('Choose a sandbox action.');
  const fields: Record<string, string[]> = {
    create_profiles: ['action', 'count'],
    save: ['action', 'config', 'profileIds'],
    run: ['action', 'config', 'profileIds'],
    bonus: ['action', 'profileIds', 'amount'],
    pause: ['action'],
    resume: ['action'],
    stop: ['action'],
  };
  if (
    !Object.hasOwn(fields, input.action) ||
    Object.keys(input).some(
      (key) => !fields[input.action as string].includes(key),
    )
  ) {
    throw new SandboxInputError('Unsupported sandbox action or setting.');
  }
  const active = state.status === 'running' || state.status === 'paused';
  if (active && !['pause', 'resume', 'stop'].includes(input.action))
    throw new SandboxInputError(
      'Stop the current test before changing profiles, credits or settings.',
      409,
    );
  if (input.action === 'create_profiles') {
    if (
      !Number.isInteger(input.count) ||
      Number(input.count) < 1 ||
      state.profiles.length + Number(input.count) > 80
    ) {
      throw new SandboxInputError(
        'The workspace supports up to 80 synthetic profiles.',
      );
    }
    for (let count = 0; count < Number(input.count); count++) {
      const suffix = String(state.profiles.length + 1).padStart(3, '0');
      state.profiles.push({
        id: `sandbox_${suffix}`,
        name: `Test profile ${suffix}`,
        balanceCents: 10_000,
        bonusCents: 0,
        allTimeValueCents: 0,
        allTimePulls: 0,
        weekly: { key: weekKey(now), valueCents: 0, pulls: 0 },
      });
    }
    state.selectedProfileIds = state.profiles.map((profile) => profile.id);
  } else if (input.action === 'bonus') {
    const ids = selected(state, input.profileIds);
    const amount = input.amount;
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 1 ||
      amount > 8000 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001
    )
      throw new SandboxInputError(
        'Test bonus must be 1–8,000 credits with at most two decimal places.',
      );
    const profiles = state.profiles.filter((profile) =>
      ids.includes(profile.id),
    );
    const cents = Math.round(amount * 100);
    if (profiles.some((profile) => profile.balanceCents + cents > 100_000_000))
      throw new SandboxInputError('Test wallet limit reached.');
    for (const profile of profiles) {
      profile.balanceCents += cents;
      profile.bonusCents += cents;
    }
  } else if (input.action === 'save' || input.action === 'run') {
    let config;
    try {
      config = validateAutomationConfig(input.config);
    } catch (error) {
      throw new SandboxInputError(
        error instanceof Error ? error.message : 'Invalid settings.',
      );
    }
    const ids = selected(state, input.profileIds);
    if (config.rankTargets?.some((target) => !ids.includes(target.profileId)))
      throw new SandboxInputError(
        'Every leaderboard target must use a selected test profile.',
      );
    state.config = config;
    state.selectedProfileIds = ids;
    if (input.action === 'run') {
      const targets = config.rankTargets ?? [];
      const runIds = targets.length
        ? targets.map((target) => target.profileId)
        : ids;
      state.results = runIds.map((id): SandboxResult => {
        const humanized =
          config.timingMode === 'humanized'
            ? createHumanizedState(id, config.humanizedRegion)
            : null;
        const target = targets.find((item) => item.profileId === id);
        return {
          profileId: id,
          profileName: state.profiles.find((profile) => profile.id === id)!
            .name,
          status: 'queued',
          cycles: [],
          nextRunAt: now,
          scheduleLabel: humanized?.label ?? null,
          waitReason: null,
          error: null,
          humanized,
          rank: target ? createRankRuntime(target, now) : null,
        };
      });
      Object.assign(state, {
        status: 'running',
        runId: randomUUID(),
        startedAt: now,
        finishedAt: null,
        nextRunAt: now,
        clockAt: now,
        spentCents: 0,
        completedCycles: 0,
        error: null,
      });
    }
  } else if (input.action === 'pause') {
    if (state.status !== 'running')
      throw new SandboxInputError('Only a running test can be paused.', 409);
    state.status = 'paused';
  } else if (input.action === 'resume') {
    if (state.status !== 'paused')
      throw new SandboxInputError('Only a paused test can be resumed.', 409);
    state.status = 'running';
    state.nextRunAt = Math.max(now + GAP, state.nextRunAt ?? 0);
  } else {
    state.status = 'stopped';
    state.nextRunAt = null;
    state.finishedAt = now;
    for (const result of state.results)
      if (!DONE.has(result.status)) {
        result.status = 'stopped';
        result.nextRunAt = null;
        result.waitReason = 'Stopped by administrator.';
      }
  }
  return state;
}

function board(
  state: SandboxState,
  period: 'weekly' | 'alltime',
): SandboxEntry[] {
  const week = weekKey(state.clockAt ?? Date.now());
  const rows = state.profiles
    .map((profile) => ({
      profileId: profile.id,
      name: profile.name,
      valueCents:
        period === 'alltime'
          ? profile.allTimeValueCents
          : profile.weekly.key === week
            ? profile.weekly.valueCents
            : 0,
      pulls:
        period === 'alltime'
          ? profile.allTimePulls
          : profile.weekly.key === week
            ? profile.weekly.pulls
            : 0,
    }))
    .filter((profile) => profile.pulls > 0);
  for (let i = 0; i < 10; i++)
    rows.push({
      profileId: `fixture_rival_${i + 1}`,
      name: `Test competitor ${i + 1}`,
      valueCents: (10 - i) * 1200,
      pulls: (10 - i) * 2,
    });
  return rows
    .sort(
      (a, b) =>
        b.valueCents - a.valueCents || a.profileId.localeCompare(b.profileId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function sandboxSnapshot(state: SandboxState): SandboxSnapshot {
  return {
    ...state,
    leaderboards: {
      weekly: board(state, 'weekly').slice(0, 10),
      alltime: board(state, 'alltime').slice(0, 10),
    },
  };
}

function finishIfDone(state: SandboxState, now: number): void {
  if (state.results.every((result) => DONE.has(result.status))) {
    state.status = state.results.some((result) => result.status === 'failed')
      ? 'failed'
      : 'completed';
    state.finishedAt = now;
    state.nextRunAt = null;
  }
}

function settleCycle(
  state: SandboxState,
  profile: SandboxProfile,
  result: SandboxResult,
  now: number,
  random: () => number,
): void {
  const fraction = random();
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
    throw new Error('Invalid sandbox random source.');
  const value = [500, 1000, 1500, 2500, 5000][Math.floor(fraction * 5)];
  const sale = (value * 80) / 100;
  const start = profile.balanceCents;
  const startBonus = profile.bonusCents;
  const bonusSpent = Math.min(COST, startBonus);
  profile.balanceCents -= COST;
  profile.bonusCents -= bonusSpent;
  profile.balanceCents += sale;
  const expected = start - COST + sale;
  const expectedBonus = Math.max(0, startBonus - COST);
  result.cycles.push({
    at: now,
    cardName: `Fixture card ${Math.floor(fraction * 5) + 1} — no redeemable value`,
    costCents: COST,
    saleCents: sale,
    startingCents: start,
    endingCents: profile.balanceCents,
    expectedCents: expected,
    differenceCents: profile.balanceCents - expected,
    startingBonusCents: startBonus,
    endingBonusCents: profile.bonusCents,
    expectedBonusCents: expectedBonus,
    bonusDifferenceCents: profile.bonusCents - expectedBonus,
  });
  profile.allTimePulls++;
  profile.allTimeValueCents += value;
  const week = weekKey(state.clockAt ?? now);
  if (profile.weekly.key !== week)
    profile.weekly = { key: week, valueCents: 0, pulls: 0 };
  profile.weekly.pulls++;
  profile.weekly.valueCents += value;
  state.completedCycles++;
  state.spentCents += COST;
  if (
    profile.balanceCents !== expected ||
    profile.bonusCents !== expectedBonus ||
    profile.bonusCents < 0 ||
    profile.bonusCents > profile.balanceCents
  ) {
    throw new Error('Test wallet reconciliation failed.');
  }
}

/** Called under the singleton row lock. No customer modules, workflows or network calls. */
export function advanceSandbox(
  state: SandboxState,
  now: number,
  random: () => number = randomFraction,
): boolean {
  if (
    state.status !== 'running' ||
    (state.nextRunAt !== null && now < state.nextRunAt)
  )
    return false;
  const result = state.results.find((entry) => !DONE.has(entry.status));
  if (!result) {
    finishIfDone(state, now);
    return true;
  }
  const profile = state.profiles.find((entry) => entry.id === result.profileId);
  if (!profile) throw new Error('Test profile missing from sandbox.');
  const accelerated = Boolean(state.config.humanizedTestClock);
  let clock = accelerated ? (state.clockAt ?? now) : now;
  if (
    result.nextRunAt !== null &&
    result.nextRunAt > clock &&
    (!result.rank || result.rank.expiresAt > now)
  ) {
    if (accelerated) clock = result.nextRunAt;
    else {
      state.nextRunAt = Math.min(
        result.nextRunAt,
        result.rank?.expiresAt ?? Infinity,
      );
      return true;
    }
  }
  state.clockAt = clock;
  state.nextRunAt = now + GAP;
  result.status = 'waiting';
  if (result.rank) {
    const period = result.rank.target.period;
    const rows = board(state, period);
    const decision = evaluateRank(
      result.rank,
      {
        periodKey: period === 'weekly' ? weekKey(clock) : 'alltime',
        observedAt: now,
        customerId: profile.id,
        ownPulls:
          period === 'weekly'
            ? profile.weekly.key === weekKey(clock)
              ? profile.weekly.pulls
              : 0
            : profile.allTimePulls,
        ownValueMyr:
          (period === 'weekly'
            ? profile.weekly.key === weekKey(clock)
              ? profile.weekly.valueCents
              : 0
            : profile.allTimeValueCents) / 100,
        entries: rows.map((entry) => ({
          customerId: entry.profileId,
          valueMyr: entry.valueCents / 100,
          pulls: entry.pulls,
        })),
      },
      {
        now,
        completedCycles: result.cycles.length,
        spentMyr: (result.cycles.length * COST) / 100,
        maxCycles: state.config.maxCyclesPerProfile,
        nextCostMyr: COST / 100,
        ownedCustomerIds: new Set(
          state.results.map((entry) => entry.profileId),
        ),
      },
    );
    result.waitReason = result.rank.status.reason;
    if (decision.done) {
      result.status = 'completed';
      result.nextRunAt = null;
      finishIfDone(state, now);
      return true;
    }
    if (!decision.draw) {
      result.nextRunAt = clock + decision.delayMs;
      state.nextRunAt = Math.min(now + decision.delayMs, result.rank.expiresAt);
      return true;
    }
  }
  if (state.spentCents + COST > Math.round(state.config.maxTotalSpend * 100)) {
    for (const entry of state.results)
      if (!DONE.has(entry.status)) {
        entry.status = 'completed';
        entry.nextRunAt = null;
        entry.waitReason = 'Batch spend limit reached.';
        if (entry.rank)
          Object.assign(entry.rank.status, {
            state: 'limited',
            reason: entry.waitReason,
            stopReason: entry.waitReason,
            eligible: false,
            wouldDraw: false,
          });
      }
    finishIfDone(state, now);
    return true;
  }
  if (result.cycles.length >= state.config.maxCyclesPerProfile) {
    result.status = 'completed';
    result.nextRunAt = null;
    finishIfDone(state, now);
    return true;
  }
  if (result.humanized) {
    let plan = planHumanized(result.humanized, clock, random);
    // Bounded clock advancement skips only virtual waiting, never cycles or ledger checks.
    for (
      let attempt = 0;
      accelerated && !plan.ready && attempt < 64;
      attempt++
    ) {
      clock += plan.delayMs;
      plan = planHumanized(result.humanized, clock, random);
    }
    state.clockAt = clock;
    if (!plan.ready) {
      result.nextRunAt = clock + plan.delayMs;
      result.waitReason = plan.reason;
      state.nextRunAt = Math.min(
        accelerated ? now + GAP : now + plan.delayMs,
        result.rank?.expiresAt ?? Infinity,
      );
      return true;
    }
  }
  if (profile.balanceCents < COST) {
    result.status = 'failed';
    result.error = 'Test wallet needs at least 10 credits.';
    result.nextRunAt = null;
    finishIfDone(state, now);
    return true;
  }
  if (result.rank) markRankDispatched(result.rank, now);
  settleCycle(state, profile, result, now, random);
  result.waitReason = null;
  const delay = result.humanized
    ? recordHumanizedCycle(result.humanized, clock, random)
    : automationDelayMs(state.config, random);
  result.nextRunAt = clock + delay;
  state.nextRunAt = Math.min(
    now + (accelerated ? GAP : Math.max(GAP, delay)),
    result.rank?.expiresAt ?? Infinity,
  );
  if (
    !result.rank &&
    result.cycles.length >= state.config.maxCyclesPerProfile
  ) {
    result.status = 'completed';
    result.nextRunAt = null;
    // A completed Humanized persona never blocks the next profile's own schedule.
    if (result.humanized) state.nextRunAt = now + GAP;
  }
  finishIfDone(state, now);
  return true;
}
