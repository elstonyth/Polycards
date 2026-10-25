import { createRankRuntime, evaluateRank } from './automation-rank';
import type { RankObservation } from './automation-rank';
import type {
  LiveRankGoal,
  LiveRankTarget,
  LiveState,
} from './automation-live-types';

/** Draws one goal account may make in a round: it pushes past the run's
 *  per-account cap until its goal is done, and this bound keeps the run's
 *  stored state small (Repeat starts another round). */
export const LIVE_GOAL_MAX_CYCLES = 100;

export function validateLiveRankTargets(
  value: unknown,
  selected: string[],
): LiveRankTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new Error('Choose at most 10 goals per leaderboard.');
  const targets: LiveRankTarget[] = [];
  for (const input of value) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !['customerId', 'period', 'targetRank'].includes(key),
      ) ||
      !selected.includes(input.customerId) ||
      targets.some((row) => row.customerId === input.customerId) ||
      // All-time only: weekly goals were dropped while automation accounts
      // could not rank weekly (#827). Bringing them back is its own change.
      input.period !== 'alltime' ||
      !Number.isInteger(input.targetRank) ||
      input.targetRank < 1 ||
      input.targetRank > 10
    ) {
      throw new Error(
        'Each live goal needs one distinct selected account, the all-time board, and rank 1–10.',
      );
    }
    targets.push({
      customerId: input.customerId,
      period: input.period,
      targetRank: input.targetRank,
    });
  }
  for (const period of ['weekly', 'alltime']) {
    const peers = targets.filter((row) => row.period === period);
    if (
      peers.some(
        (row) =>
          peers.filter((peer) => peer.targetRank <= row.targetRank).length >
          row.targetRank,
      )
    )
      throw new Error(
        'Live rank goals conflict: more accounts target a Top N than available places.',
      );
  }
  return targets;
}

export function refreshLiveRankGoals(
  state: LiveState,
  observations: (RankObservation | null)[],
  now: number,
): void {
  if (
    state.status !== 'running' ||
    state.pending ||
    !state.config?.rankTargets?.length
  )
    return;
  const config = state.config;
  state.rankGoals ??= config.rankTargets!.map((target): LiveRankGoal => ({
    ...createRankRuntime(
      {
        profileId: target.customerId,
        period: target.period,
        targetRank: target.targetRank,
        mode: 'live',
        goal: 'reach',
        secureBufferMyr: 0,
        threatBufferMyr: 0,
        maxCycles: LIVE_GOAL_MAX_CYCLES,
        maxSpendMyr: 0,
        maxDurationMinutes: 0,
      },
      now,
    ),
    done: false,
    nextCheckAt: now,
    observationExpiresAt: now,
  }));
  for (const goal of state.rankGoals) {
    if (goal.done || goal.nextCheckAt > now) continue;
    const observation =
      observations.find(
        (row) =>
          row?.customerId === goal.target.profileId &&
          (goal.target.period === 'alltime'
            ? row.periodKey === 'alltime'
            : row.periodKey !== 'alltime'),
      ) ?? null;
    const cycles = state.cycles.filter(
      (row) => row.customerId === goal.target.profileId,
    );
    goal.observationExpiresAt = observation
      ? Math.min(
          observation.observedAt + 15000,
          observation.validUntil ?? Number.MAX_SAFE_INTEGER,
        )
      : now;
    const result = evaluateRank(goal, observation, {
      now,
      completedCycles: cycles.length,
      spentMyr: 0,
      maxCycles: LIVE_GOAL_MAX_CYCLES,
      nextCostMyr: state.packPriceCents / 100,
      ownedCustomerIds: new Set(config.customerIds),
    });
    goal.done = result.done;
    goal.nextCheckAt = now + result.delayMs;
  }
}

export function liveRankReady(
  state: LiveState,
  customerId: string,
  now: number,
): boolean {
  // An account without a goal draws ordinarily, goal run or not.
  if (
    !state.config?.rankTargets?.some(
      (target) => target.customerId === customerId,
    )
  )
    return true;
  const goal = state.rankGoals?.find(
    (row) => row.target.profileId === customerId,
  );
  return (
    !!goal &&
    !goal.done &&
    goal.status.eligible &&
    goal.observationExpiresAt > now &&
    goal.status.observedAt !== null &&
    now - Date.parse(goal.status.observedAt) <= 15000 &&
    Date.parse(goal.status.observedAt) <= now
  );
}

export function liveRankTargetsToObserve(
  state: LiveState,
  now: number,
): LiveRankTarget[] {
  return (state.config?.rankTargets ?? []).filter((target) => {
    const goal = state.rankGoals?.find(
      (row) => row.target.profileId === target.customerId,
    );
    if (!goal) return true;
    if (goal.done) return false;
    const schedule = state.schedules?.find(
      (row) => row.customerId === target.customerId,
    );
    const drawDue =
      state.config?.timingMode === 'humanized'
        ? !schedule || schedule.nextRunAt <= now
        : (state.nextDrawAt ?? 0) <= now;
    // Re-observe at dispatch, even inside the check interval: the week may have reset.
    if (goal.status.eligible && drawDue)
      goal.nextCheckAt = Math.min(goal.nextCheckAt, now);
    return goal.nextCheckAt <= now;
  });
}

export function nextLiveRankCheck(state: LiveState, now: number): number {
  return Math.min(
    ...(state.rankGoals
      ?.filter((row) => !row.done)
      .map((row) => row.nextCheckAt) ?? [now + 2000]),
  );
}
