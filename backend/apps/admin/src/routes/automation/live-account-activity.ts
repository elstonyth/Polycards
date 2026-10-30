import type { LiveSnapshot } from '../../../../../packages/api/src/api/utils/automation-live-types';
import {
  LIVE_GOAL_MAX_CYCLES,
  liveRankReady,
} from '../../../../../packages/api/src/api/utils/automation-live-rank';

export interface LiveAccountActivity {
  label: string;
  color: 'grey' | 'blue' | 'purple' | 'orange' | 'green' | 'red';
  reason: string;
  nextCheckAt: number | null;
  settledCycles: number;
}

export function getLiveAccountActivity(
  state: LiveSnapshot,
  customerId: string,
  selected: boolean,
  now = Date.now(),
): LiveAccountActivity {
  const cycles = state.cycles.filter(
    (cycle) => cycle.customerId === customerId,
  );
  const settledCycles = cycles.filter(
    (cycle) =>
      cycle.finishedAt &&
      !cycle.error &&
      cycle.differenceCents === 0 &&
      cycle.bonusDifferenceCents === 0,
  ).length;
  const activity = (
    label: string,
    color: LiveAccountActivity['color'],
    reason: string,
    nextCheckAt: number | null = null,
  ): LiveAccountActivity => ({
    label,
    color,
    reason,
    nextCheckAt,
    settledCycles,
  });
  if (!selected)
    return activity('Not selected', 'grey', 'No action scheduled.');
  if (state.pending?.customerId === customerId) {
    if (state.status === 'failed' || state.pending.error)
      return activity(
        'Failed',
        'red',
        state.pending.error ?? state.error ?? 'Interrupted draw needs review.',
      );
    return state.pending.pullId
      ? activity(
          'Settling',
          'purple',
          'Selling the drawn card and verifying its settlement.',
        )
      : activity('Drawing', 'blue', 'Opening the paid pack.');
  }
  const skipped = cycles.find((cycle) => cycle.skipped);
  if (skipped) return activity('Out of balance', 'orange', skipped.skipped!);
  const failed = cycles.find(
    (cycle) =>
      cycle.error ||
      (cycle.finishedAt &&
        (cycle.differenceCents !== 0 || cycle.bonusDifferenceCents !== 0)),
  );
  if (failed)
    return activity(
      'Failed',
      'red',
      failed.error ?? 'Settlement balance mismatch needs review.',
    );
  const ranked = !!state.config?.rankTargets?.length;
  // Accounts without a goal draw ordinarily, also in a run with goals.
  const isGoal = (id: string) =>
    !!state.config?.rankTargets?.some((target) => target.customerId === id);
  const goal = isGoal(customerId)
    ? state.rankGoals?.find((row) => row.target.profileId === customerId)
    : undefined;
  if (goal?.done)
    return activity(
      goal.status.state === 'secured'
        ? 'Rank goal reached'
        : goal.status.state === 'limited'
          ? 'Goal limit reached'
          : 'Goal needs review',
      goal.status.state === 'secured' ? 'green' : 'orange',
      goal.status.reason,
    );
  if (
    !isGoal(customerId) &&
    settledCycles >= (state.config?.maxCyclesPerAccount ?? 1)
  )
    return activity(
      'Completed',
      'green',
      'All configured draws settled and verified.',
    );
  if (state.status === 'failed')
    return activity(
      'Blocked',
      'red',
      state.error ?? 'Run failed; awaiting review.',
    );
  if (state.status === 'paused')
    return activity('Paused', 'orange', 'Waiting for the run to resume.');
  if (state.status === 'stopped')
    return activity('Stopped', 'grey', 'No further draws scheduled.');
  if (state.status === 'completed')
    return activity(
      'Blocked',
      'red',
      'Run ended before this account completed its draws.',
    );
  if (state.status !== 'running')
    return activity('Ready', 'grey', 'Waiting for a live run to start.');
  if (isGoal(customerId) && !goal?.status.eligible)
    return activity(
      goal?.status.state === 'stale'
        ? 'Rank data unavailable'
        : 'Checking rank',
      'orange',
      goal?.status.reason ?? 'Waiting for a fresh live leaderboard.',
      goal?.nextCheckAt ?? state.nextRunAt,
    );
  if (state.config?.timingMode === 'humanized') {
    const schedule = state.schedules?.find(
      (row) => row.customerId === customerId,
    );
    if (!schedule)
      return activity(
        'Pending',
        'orange',
        'Waiting for the activity schedule to be prepared.',
      );
    if (schedule.nextRunAt <= now)
      return activity(
        'Pending',
        'orange',
        'Scheduled check is due; waiting for the live worker.',
        schedule.nextRunAt,
      );
    const resting = schedule.humanized.timerKind
      ? ['OFFLINE_END', 'SESSION_BREAK_END', 'SHORT_BREAK_END'].includes(
          schedule.humanized.timerKind,
        )
      : schedule.waitReason.startsWith('Sleeping') ||
        ['Between activity sessions', 'Session break'].includes(
          schedule.waitReason,
        );
    return activity(
      resting
        ? 'Resting'
        : schedule.humanized.behaviorState === 'THINKING'
          ? 'Thinking'
          : 'Waiting',
      resting ? 'grey' : 'orange',
      schedule.waitReason,
      schedule.nextRunAt,
    );
  }
  // Same order as claimLiveCycle: a ready goal account goes first.
  const queue =
    state.config?.customerIds.filter(
      (id) =>
        liveRankReady(state, id, now) &&
        state.cycles.filter((cycle) => cycle.customerId === id).length <
          (isGoal(id)
            ? LIVE_GOAL_MAX_CYCLES
            : (state.config?.maxCyclesPerAccount ?? 1)),
    ) ?? [];
  const nextCustomer = queue.find(isGoal) ?? queue[0];
  if (customerId !== nextCustomer || state.pending)
    return activity(
      'Pending',
      'orange',
      'Waiting for earlier accounts to finish.',
    );
  const nextDrawAt = ranked
    ? (state.nextDrawAt ?? state.nextRunAt)
    : state.nextRunAt;
  return nextDrawAt && nextDrawAt > now
    ? activity(
        'Waiting',
        'orange',
        'Waiting for the configured draw interval.',
        nextDrawAt,
      )
    : activity(
        'Pending',
        'orange',
        'Waiting for the live worker to begin the draw.',
        state.nextRunAt,
      );
}
