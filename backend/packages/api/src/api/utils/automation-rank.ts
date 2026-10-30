import type {
  AutomationRankStatus,
  AutomationRankTarget,
} from './automation-types';

const money = (value: unknown, max: number) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max &&
  Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = [
  'profileId',
  'period',
  'mode',
  'goal',
  'targetRank',
  'secureBufferMyr',
  'threatBufferMyr',
  'maxCycles',
  'maxSpendMyr',
  'maxDurationMinutes',
];

export function validateRankTargets(value: unknown): AutomationRankTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 80)
    throw new Error('Choose at most 80 leaderboard targets.');
  const seen = new Set<string>();
  const targets = value.map((input): AutomationRankTarget => {
    if (
      !object(input) ||
      Object.keys(input).some((key) => !keys.includes(key)) ||
      typeof input.profileId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.profileId) ||
      seen.has(input.profileId) ||
      typeof input.period !== 'string' ||
      !['weekly', 'alltime'].includes(input.period) ||
      typeof input.mode !== 'string' ||
      !['monitor', 'shadow', 'test'].includes(input.mode) ||
      typeof input.goal !== 'string' ||
      !['reach', 'maintain'].includes(input.goal) ||
      !Number.isInteger(input.targetRank) ||
      Number(input.targetRank) < 1 ||
      Number(input.targetRank) > 10 ||
      !money(input.secureBufferMyr, 1_000_000) ||
      !money(input.threatBufferMyr, 1_000_000) ||
      Number(input.threatBufferMyr) > Number(input.secureBufferMyr) ||
      !Number.isInteger(input.maxCycles) ||
      Number(input.maxCycles) < 1 ||
      Number(input.maxCycles) > 10 ||
      !money(input.maxSpendMyr, 100) ||
      Number(input.maxSpendMyr) < 10 ||
      !Number.isInteger(input.maxDurationMinutes) ||
      Number(input.maxDurationMinutes) < 1 ||
      Number(input.maxDurationMinutes) > 60
    ) {
      throw new Error(
        'Each leaderboard target needs one distinct sandbox profile, a valid scope, rank 1–10, ordered buffers, and finite cycle, spend and duration limits.',
      );
    }
    seen.add(input.profileId);
    return Object.fromEntries(
      keys.map((key) => [key, input[key]]),
    ) as unknown as AutomationRankTarget;
  });
  for (const period of ['weekly', 'alltime']) {
    const active = targets.filter(
      (target) => target.mode === 'test' && target.period === period,
    );
    if (
      active.some(
        (target) =>
          active.filter((peer) => peer.targetRank <= target.targetRank).length >
          target.targetRank,
      )
    ) {
      throw new Error(
        'Leaderboard targets conflict: more sandbox profiles are aiming for a Top N than available places.',
      );
    }
  }
  return targets;
}

export interface RankObservation {
  periodKey: string;
  observedAt: number;
  validUntil?: number;
  customerId: string;
  ownPulls: number;
  ownValueMyr: number;
  entries: { customerId: string; pulls: number; valueMyr: number }[];
}

export interface RankRuntime {
  target: AutomationRankTarget;
  status: AutomationRankStatus;
  expiresAt: number;
  periodKey: string | null;
  lastObservation: number | null;
  heldSamples: number;
  lostSamples: number;
  reachedOnce: boolean;
  pending: { since: number; pullsBefore: number; valueBefore: number } | null;
  lastOwnPulls: number;
}

export function createRankRuntime(
  target: AutomationRankTarget,
  now: number,
): RankRuntime {
  return {
    target,
    expiresAt:
      target.mode === 'live'
        ? Number.MAX_SAFE_INTEGER
        : now + target.maxDurationMinutes * 60_000,
    periodKey: null,
    lastObservation: null,
    heldSamples: 0,
    lostSamples: 0,
    reachedOnce: false,
    pending: null,
    lastOwnPulls: 0,
    status: {
      state: 'ready',
      reason:
        target.mode === 'live'
          ? 'Waiting for a fresh live leaderboard.'
          : 'Waiting for a fresh sandbox leaderboard.',
      period: target.period,
      mode: target.mode,
      targetRank: target.targetRank,
      currentRank: null,
      pulledValueMyr: null,
      gapMyr: null,
      leadMyr: null,
      observedAt: null,
      wouldDraw: false,
      eligible: false,
      events: [],
    },
  };
}

type Decision = { draw: boolean; done: boolean; delayMs: number };

function decision(
  runtime: RankRuntime,
  state: string,
  reason: string,
  now: number,
  draw = false,
  done = false,
): Decision {
  const status = runtime.status;
  if (status.state !== state || status.reason !== reason) {
    status.events.push({
      at: new Date(now).toISOString(),
      type: state,
      message: reason,
    });
    status.events = status.events.slice(-50);
  }
  Object.assign(status, {
    state,
    reason,
    wouldDraw: draw,
    eligible: draw && ['test', 'live'].includes(runtime.target.mode),
  });
  if (done) status.stopReason = reason;
  return {
    draw: status.eligible,
    done,
    delayMs: state === 'confirming' || state === 'pending' ? 2000 : 15_000,
  };
}

export function markRankDispatched(runtime: RankRuntime, now: number): void {
  if (
    runtime.status.pulledValueMyr === null ||
    !runtime.status.eligible ||
    runtime.pending
  )
    throw new Error('Rank draw was not eligible.');
  runtime.pending = {
    since: now,
    pullsBefore: runtime.lastOwnPulls,
    valueBefore: runtime.status.pulledValueMyr,
  };
  runtime.status.eligible = false;
}

/** Rank eligibility gates the existing schedule; it never owns or accelerates timing. */
export function evaluateRank(
  runtime: RankRuntime,
  observation: RankObservation | null,
  options: {
    now: number;
    completedCycles: number;
    spentMyr: number;
    maxCycles: number;
    nextCostMyr: number;
    ownedCustomerIds: Set<string>;
  },
): Decision {
  const { now } = options;
  const { target, status } = runtime;
  if (now >= runtime.expiresAt)
    return decision(
      runtime,
      'limited',
      'Rank monitoring duration reached.',
      now,
      false,
      true,
    );
  if (
    !observation ||
    !Number.isFinite(observation.observedAt) ||
    now - observation.observedAt > 15_000 ||
    observation.observedAt > now ||
    (observation.validUntil !== undefined &&
      (!Number.isFinite(observation.validUntil) ||
        observation.validUntil <= now)) ||
    !money(observation.ownValueMyr, 1_000_000_000) ||
    !Number.isInteger(observation.ownPulls) ||
    observation.ownPulls < 0 ||
    observation.entries.some(
      (row) =>
        !row.customerId ||
        !Number.isInteger(row.pulls) ||
        row.pulls < 0 ||
        !money(row.valueMyr, 1_000_000_000),
    )
  ) {
    return decision(
      runtime,
      'stale',
      'Fresh leaderboard data unavailable; holding without drawing.',
      now,
      false,
      !['test', 'live'].includes(target.mode),
    );
  }
  if (
    runtime.periodKey !== null &&
    runtime.periodKey !== observation.periodKey
  ) {
    // A previous week's pending pull cannot confirm a new week's position.
    return decision(
      runtime,
      'period_changed',
      'Leaderboard period changed; start a new run to target the new period.',
      now,
      false,
      true,
    );
  }
  runtime.periodKey = observation.periodKey;
  const ownChanged =
    runtime.lastOwnPulls !== observation.ownPulls ||
    status.pulledValueMyr !== observation.ownValueMyr;
  status.observedAt = new Date(observation.observedAt).toISOString();
  runtime.lastOwnPulls = observation.ownPulls;
  status.pulledValueMyr = observation.ownValueMyr;
  const ownIndex = observation.entries.findIndex(
    (row) => row.customerId === observation.customerId,
  );
  status.currentRank = ownIndex < 0 ? null : ownIndex + 1;
  const held =
    status.currentRank !== null && status.currentRank <= target.targetRank;
  const belowCut = observation.entries
    .filter((row) => row.customerId !== observation.customerId)
    .slice(target.targetRank - 1);
  const boundary = held
    ? belowCut.find((row) => !options.ownedCustomerIds.has(row.customerId))
    : belowCut[0];
  const ownCents = Math.round(observation.ownValueMyr * 100);
  const boundaryCents = boundary ? Math.round(boundary.valueMyr * 100) : null;
  status.gapMyr =
    boundaryCents === null
      ? null
      : Math.max(0, boundaryCents - ownCents + 1) / 100;
  status.leadMyr =
    boundaryCents === null ? null : (ownCents - boundaryCents) / 100;
  if (runtime.pending) {
    if (
      observation.ownPulls > runtime.pending.pullsBefore &&
      ownCents > Math.round(runtime.pending.valueBefore * 100)
    ) {
      runtime.pending = null;
    } else if (
      now - runtime.pending.since >=
      (target.period === 'alltime' ? 45_000 : 30_000)
    ) {
      return decision(
        runtime,
        'pending_timeout',
        'Own pull and value update could not be confirmed; no further draw allowed.',
        now,
        false,
        true,
      );
    } else {
      return decision(
        runtime,
        'pending',
        'Waiting for this account’s own pull count and value to update.',
        now,
      );
    }
  }
  const freshSample =
    runtime.lastObservation !== observation.observedAt || ownChanged;
  runtime.lastObservation = observation.observedAt;
  if (freshSample) {
    runtime.heldSamples = held ? runtime.heldSamples + 1 : 0;
    runtime.lostSamples = held ? 0 : runtime.lostSamples + 1;
  }
  const modeDone = !['test', 'live'].includes(target.mode);
  if (!held) {
    // Drawing modes push past one of our own accounts at the target rank;
    // monitor and shadow only report it.
    if (
      modeDone &&
      boundary &&
      options.ownedCustomerIds.has(boundary.customerId)
    ) {
      return decision(
        runtime,
        'conflict',
        'Another account in this run occupies the target boundary; holding to avoid an owned-account contest.',
        now,
        false,
        modeDone,
      );
    }
    if (runtime.reachedOnce && runtime.lostSamples < 2) {
      return decision(
        runtime,
        'confirming',
        'Possible rank loss; waiting for another fresh observation before defending.',
        now,
        false,
        modeDone,
      );
    }
  } else {
    if (runtime.heldSamples < 2 && !modeDone)
      return decision(
        runtime,
        'confirming',
        'Target position observed; waiting for a second fresh confirmation.',
        now,
      );
    runtime.reachedOnce = true;
    const secure =
      boundaryCents === null ||
      ownCents - boundaryCents >= Math.round(target.secureBufferMyr * 100);
    if (secure)
      return decision(
        runtime,
        target.goal === 'reach' ? 'secured' : 'holding',
        boundaryCents === null
          ? 'Target rank confirmed; no visible external competitor below to measure a buffer.'
          : target.goal === 'reach'
            ? 'Target rank and secure buffer confirmed.'
            : 'Target secure; monitoring competitors without drawing.',
        now,
        false,
        modeDone || target.goal === 'reach',
      );
    if (
      target.goal === 'maintain' &&
      ownCents - (boundaryCents ?? 0) > Math.round(target.threatBufferMyr * 100)
    ) {
      return decision(
        runtime,
        'holding',
        'Target held above the threat buffer; monitoring without drawing.',
        now,
        false,
        modeDone,
      );
    }
  }
  if (
    options.completedCycles >= Math.min(target.maxCycles, options.maxCycles) ||
    (target.mode !== 'live' &&
      Math.round(options.spentMyr * 100) +
        Math.round(options.nextCostMyr * 100) >
        Math.round(target.maxSpendMyr * 100))
  ) {
    return decision(
      runtime,
      'limited',
      'Rank cycle or spend cap reached before another draw.',
      now,
      false,
      true,
    );
  }
  if (target.mode === 'monitor')
    return decision(
      runtime,
      'monitoring',
      held
        ? 'Target threatened; monitor mode does not draw.'
        : 'Target not reached; monitor mode does not draw.',
      now,
      false,
      true,
    );
  return decision(
    runtime,
    held ? 'threatened' : runtime.reachedOnce ? 'defending' : 'pushing',
    held
      ? 'Lead is below the configured buffer; another scheduled cycle is eligible.'
      : runtime.reachedOnce
        ? 'Rank loss confirmed; another scheduled cycle is eligible to defend.'
        : 'Below target rank; another scheduled cycle is eligible.',
    now,
    true,
    modeDone,
  );
}

export function persistedRankStatus(
  value: unknown,
): AutomationRankStatus | undefined {
  if (
    !object(value) ||
    typeof value.period !== 'string' ||
    !['weekly', 'alltime'].includes(value.period) ||
    typeof value.mode !== 'string' ||
    !['monitor', 'shadow', 'test'].includes(value.mode) ||
    typeof value.state !== 'string' ||
    value.state.length > 40 ||
    typeof value.reason !== 'string' ||
    value.reason.length > 300 ||
    !Number.isInteger(value.targetRank) ||
    Number(value.targetRank) < 1 ||
    Number(value.targetRank) > 10 ||
    typeof value.wouldDraw !== 'boolean' ||
    typeof value.eligible !== 'boolean' ||
    !Array.isArray(value.events) ||
    value.events.length > 50
  )
    return undefined;
  for (const key of ['currentRank', 'pulledValueMyr', 'gapMyr', 'leadMyr']) {
    if (
      value[key] !== null &&
      (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    )
      return undefined;
  }
  if (
    value.observedAt !== null &&
    (typeof value.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.observedAt)))
  )
    return undefined;
  if (
    value.stopReason !== undefined &&
    (typeof value.stopReason !== 'string' || value.stopReason.length > 300)
  )
    return undefined;
  const events = value.events.filter(
    (event): event is { at: string; type: string; message: string } =>
      object(event) &&
      typeof event.at === 'string' &&
      Number.isFinite(Date.parse(event.at)) &&
      typeof event.type === 'string' &&
      event.type.length <= 40 &&
      typeof event.message === 'string' &&
      event.message.length <= 300,
  );
  if (events.length !== value.events.length) return undefined;
  return {
    state: value.state,
    reason: value.reason,
    period: value.period as AutomationRankStatus['period'],
    mode: value.mode as AutomationRankStatus['mode'],
    targetRank: value.targetRank as number,
    currentRank: value.currentRank as number | null,
    pulledValueMyr: value.pulledValueMyr as number | null,
    gapMyr: value.gapMyr as number | null,
    leadMyr: value.leadMyr as number | null,
    observedAt: value.observedAt as string | null,
    wouldDraw: value.wouldDraw,
    eligible: value.eligible,
    events: events.map(({ at, type, message }) => ({ at, type, message })),
    ...(value.stopReason === undefined
      ? {}
      : { stopReason: value.stopReason as string }),
  };
}
