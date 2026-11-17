import { randomInt, randomUUID } from 'node:crypto';
import { automationDelayMs } from './automation-config';
import {
  createHumanizedStates,
  rememberHumanizedAssignments,
  planHumanized,
  recordHumanizedCycle,
} from './automation-humanized';
import { DEFAULT_LIVE_TIMING } from './automation-live-types';
import {
  LIVE_GOAL_MAX_CYCLES,
  liveRankReady,
  nextLiveRankCheck,
  validateLiveRankTargets,
} from './automation-live-rank';
import { markRankDispatched } from './automation-rank';
import type {
  LiveConfig,
  LiveCycle,
  LiveCycleAmounts,
  LivePackWeight,
  LiveRunSummary,
  LiveSchedule,
  LiveState,
} from './automation-live-types';

export function createLiveState(): LiveState {
  return {
    version: 1,
    mode: 'live',
    status: 'idle',
    config: null,
    runId: null,
    packPriceCents: 0,
    spentCents: 0,
    nextRunAt: null,
    pending: null,
    cycles: [],
    error: null,
    schedules: [],
  };
}

const timingRandom = () => randomInt(1_000_000) / 1_000_000;
const pace = (state: LiveState) =>
  state.config?.humanizedPace ?? DEFAULT_LIVE_TIMING.humanizedPace;

/**
 * Humanized speed is a clock multiplier: the simulated players live on a
 * virtual clock that runs `pace` times faster than real time from the run's
 * start, so sessions, breaks, sleep and days all shrink together (5× = one
 * player day in about 4.8 real hours). Pace 1 is the real clock.
 */
function playerClock(state: LiveState, now: number) {
  const speed = pace(state);
  const start = state.clockStartedAt ?? (state.startedAt ??= now);
  return {
    now: start + (now - start) * speed,
    /** A virtual instant or duration converted back to real time. */
    toRealAt: (virtualAt: number) => start + (virtualAt - start) / speed,
    toRealMs: (virtualMs: number) => Math.ceil(virtualMs / speed),
  };
}

/**
 * One draw's pack from a weighted mix (weights in basis points). Packs the
 * account cannot afford drop out and the rest keep their relative weights, so
 * a rare expensive pick never fails the whole run on a low balance. With none
 * affordable the full mix is used and the open fails as a single-pack run does.
 */
export function pickLivePack(
  mix: LivePackWeight[],
  pricesCents: Record<string, number>,
  balanceCents: number,
  random: () => number = timingRandom,
): string {
  const affordable = mix.filter(
    (row) => (pricesCents[row.packSlug] ?? Infinity) <= balanceCents,
  );
  const pool = affordable.length ? affordable : mix;
  let roll = random() * pool.reduce((sum, row) => sum + row.weightBp, 0);
  for (const row of pool) {
    roll -= row.weightBp;
    if (roll < 0) return row.packSlug;
  }
  return pool[pool.length - 1].packSlug;
}

const SLUG = /^[a-zA-Z0-9_-]{1,160}$/;

/** Weights are whole basis points summing to exactly 100% (10000). Zero rows drop. */
export function validateLivePackMix(value: unknown): LivePackWeight[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 30 ||
    value.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).some(
          (key) => !['packSlug', 'weightBp'].includes(key),
        ) ||
        typeof row.packSlug !== 'string' ||
        !SLUG.test(row.packSlug) ||
        !Number.isInteger(row.weightBp) ||
        row.weightBp < 0 ||
        row.weightBp > 10000,
    ) ||
    new Set(value.map((row) => row.packSlug)).size !== value.length ||
    value.reduce((sum, row) => sum + row.weightBp, 0) !== 10000
  )
    throw new Error(
      'Pack rates need distinct paid packs with rates in steps of 0.01% that add up to exactly 100%.',
    );
  return value
    .filter((row) => row.weightBp > 0)
    .map((row) => ({ packSlug: row.packSlug, weightBp: row.weightBp }));
}

/** Accounts with a leaderboard goal in this run. The rest draw ordinarily. */
const goalAccount = (state: LiveState, id: string) =>
  !!state.config?.rankTargets?.some((target) => target.customerId === id);

function remainingCustomers(state: LiveState): string[] {
  const { config } = state;
  if (!config) return [];
  return config.customerIds.filter(
    (id) =>
      !state.rankGoals?.some(
        (goal) => goal.target.profileId === id && goal.done,
      ) &&
      // An account that ran out of balance is finished for this run.
      !state.cycles.some((cycle) => cycle.customerId === id && cycle.skipped) &&
      state.cycles.filter((cycle) => cycle.customerId === id).length <
        // A goal account pushes until its goal is done, not the per-account cap.
        (goalAccount(state, id)
          ? LIVE_GOAL_MAX_CYCLES
          : config.maxCyclesPerAccount),
  );
}

/** A finished round may start the next one by itself (config.repeat) unless
 *  it failed or was stopped, drew nothing (every account out of balance would
 *  restart it every tick), or stopped a goal for safety. */
export function canRepeatLiveRound(state: LiveState): boolean {
  return (
    state.status === 'completed' &&
    !!state.config?.repeat &&
    !state.pending &&
    state.cycles.some((cycle) => !cycle.skipped && !cycle.error) &&
    !state.rankGoals?.some(
      (goal) =>
        goal.done && !['secured', 'limited'].includes(goal.status.state),
    )
  );
}

/** Starts a round: the finished one goes to history, cycles, goals and spend
 *  reset. A repeated round (carryOver) keeps the Humanized schedules and their
 *  clock, so the accounts carry on their day instead of all waking at once. */
export function beginLiveRound(
  state: LiveState,
  round: Pick<LiveState, 'packPriceCents' | 'packPricesCents'> & {
    config: LiveConfig;
  },
  now: number,
  carryOver: boolean,
): void {
  const finished = summarizeLiveRun(state);
  if (finished?.draws)
    state.history = [finished, ...(state.history ?? [])].slice(0, 30);
  const { config } = round;
  if (carryOver) state.clockStartedAt ??= state.startedAt;
  else state.clockStartedAt = undefined;
  Object.assign(state, {
    config,
    packPriceCents: round.packPriceCents,
    packPricesCents: round.packPricesCents,
    status: 'running',
    runId: randomUUID(),
    startedAt: now,
    spentCents: 0,
    cycles: [],
    schedules:
      config.timingMode !== 'humanized'
        ? []
        : carryOver
          ? (state.schedules ?? []).filter((row) =>
              config.customerIds.includes(row.customerId),
            )
          : createHumanizedStates(
              config.customerIds,
              config.humanizedRegion ?? 'mysg',
              state.humanizedAssignments,
            ).map((humanized) => ({
              customerId: humanized.profileId,
              humanized,
              nextRunAt: now,
              waitReason: 'Planning activity',
            })),
    rankGoals: undefined,
    nextDrawAt: undefined,
    nextRunAt: now,
    error: null,
  });
}

/** A finished-or-current run in one row, for the run history list. */
export function summarizeLiveRun(state: LiveState): LiveRunSummary | null {
  if (!state.runId || !state.config) return null;
  const settled = state.cycles.filter(
    (cycle) =>
      !cycle.error &&
      cycle.differenceCents === 0 &&
      cycle.bonusDifferenceCents === 0,
  );
  return {
    runId: state.runId,
    startedAt: state.startedAt ?? state.cycles[0]?.startedAt ?? null,
    endedAt: state.cycles.at(-1)?.finishedAt ?? null,
    status: state.status,
    draws: state.cycles.filter((cycle) => !cycle.skipped).length,
    settled: settled.length,
    failed:
      state.cycles.filter((cycle) => !cycle.skipped).length - settled.length,
    spentCents: state.spentCents,
    soldCents: settled.reduce((sum, cycle) => sum + (cycle.saleCents ?? 0), 0),
    accounts: new Set(state.cycles.map((cycle) => cycle.customerId)).size,
    packSlugs: state.config.packMix?.map((row) => row.packSlug) ?? [
      state.config.packSlug,
    ],
    timingMode: state.config.timingMode ?? DEFAULT_LIVE_TIMING.timingMode,
  };
}

export function claimLiveCycle(
  state: LiveState,
  now: number,
  random: () => number = timingRandom,
): LiveCycle | null {
  if (state.pending) {
    // shortcut: interrupted money operations need operator review; never replay an uncertain debit.
    if (now - state.pending.startedAt > 300000) {
      state.status = 'failed';
      state.error = `Interrupted cycle ${state.pending.id}: review its pull and ledger before another run.`;
    }
    return null;
  }
  if (
    state.status !== 'running' ||
    !state.config ||
    (state.nextRunAt ?? 0) > now
  )
    return null;
  const remaining = remainingCustomers(state);
  const ranked = !!state.config.rankTargets?.length;
  if (!remaining.length) {
    const done =
      !ranked ||
      (!!state.rankGoals?.length && state.rankGoals.every((goal) => goal.done));
    state.status = done ? 'completed' : 'running';
    state.nextRunAt = done
      ? null
      : Math.max(now + 2000, nextLiveRankCheck(state, now));
    return null;
  }
  const eligible = remaining.filter((id) => liveRankReady(state, id, now));
  // A goal account draws as soon as its fresh rank check allows; the other
  // accounts fill the run's draw slots between its draws.
  let customerId = eligible.find((id) => goalAccount(state, id)) ?? eligible[0];
  if (!customerId) {
    state.nextRunAt = Math.max(now + 2000, nextLiveRankCheck(state, now));
    return null;
  }
  if (
    ranked &&
    state.config.timingMode !== 'humanized' &&
    (state.nextDrawAt ?? 0) > now
  ) {
    state.nextRunAt = Math.min(
      state.nextDrawAt!,
      Math.max(now + 2000, nextLiveRankCheck(state, now)),
    );
    return null;
  }
  if (state.config.timingMode === 'humanized') {
    for (const row of state.schedules ?? [])
      row.humanized.regionChoice ??=
        state.config.humanizedRegion ?? DEFAULT_LIVE_TIMING.humanizedRegion;
    state.humanizedAssignments = rememberHumanizedAssignments(
      state.humanizedAssignments ?? [],
      state.schedules?.map((row) => row.humanized) ?? [],
    );
    const assignments = createHumanizedStates(
      state.config.customerIds,
      state.config.humanizedRegion ?? DEFAULT_LIVE_TIMING.humanizedRegion,
      state.humanizedAssignments,
    );
    const clock = playerClock(state, now);
    state.schedules = state.config.customerIds.map((id) => {
      const previous = state.schedules?.find((row) => row.customerId === id);
      if (previous && (previous.nextRunAt > now || !remaining.includes(id)))
        return previous;
      const humanized = previous
        ? { ...previous.humanized }
        : assignments.find((row) => row.profileId === id)!;
      if (!humanized.timerKind) humanized.waitReason = previous?.waitReason;
      const plan = planHumanized(humanized, clock.now, random);
      return {
        customerId: id,
        humanized,
        // A due draw keeps its due time, so the longest-waiting account goes first.
        nextRunAt: plan.ready
          ? Math.min(now, clock.toRealAt(humanized.nextDrawAt ?? clock.now))
          : now + clock.toRealMs(plan.delayMs),
        waitReason: plan.reason,
      };
    });
    state.humanizedAssignments = rememberHumanizedAssignments(
      state.humanizedAssignments,
      assignments,
    );
    state.nextRunAt = Math.min(
      ...state.schedules
        .filter(
          (row) =>
            remaining.includes(row.customerId) &&
            eligible.includes(row.customerId),
        )
        .map((row) => row.nextRunAt),
    );
    // Draws run one at a time, so serve the longest-waiting account first;
    // list order would starve the accounts at the end of a busy queue. A
    // ready goal account still goes before the ordinary ones.
    const due = state.schedules.filter(
      (row) =>
        remaining.includes(row.customerId) &&
        row.nextRunAt <= now &&
        eligible.includes(row.customerId),
    );
    const longestWaiting = (rows: LiveSchedule[]) =>
      rows.reduce<LiveSchedule | undefined>(
        (best, row) => (best && best.nextRunAt <= row.nextRunAt ? best : row),
        undefined,
      );
    const ready =
      longestWaiting(due.filter((row) => goalAccount(state, row.customerId))) ??
      longestWaiting(due);
    if (ranked)
      state.nextRunAt = Math.min(
        state.nextRunAt,
        Math.max(now + 2000, nextLiveRankCheck(state, now)),
      );
    if (!ready) return null;
    customerId = ready.customerId;
  }
  const goal = state.rankGoals?.find(
    (row) => row.target.profileId === customerId,
  );
  if (ranked && goal) markRankDispatched(goal, now);
  state.pending = {
    id: randomUUID(),
    customerId,
    startedAt: now,
    finishedAt: null,
    error: null,
  };
  return state.pending;
}

export function completeLiveCycle(
  state: LiveState,
  cycle: LiveCycle,
  now: number,
  random: () => number = timingRandom,
): void {
  if (state.pending?.id !== cycle.id)
    throw new Error('Live cycle ownership changed. Review the ledger.');
  state.cycles.push({ ...cycle, finishedAt: now });
  state.spentCents += cycle.costCents ?? 0;
  state.pending = null;
  // A skip happens before any money moves (see tickLive), so it ends only
  // that account's draws; anything else unexpected stops the run for review.
  if (
    !cycle.skipped &&
    (cycle.error ||
      cycle.differenceCents !== 0 ||
      cycle.bonusDifferenceCents !== 0)
  ) {
    state.status = 'failed';
    state.error =
      cycle.error ??
      'Balance verification differs from the expected settlement. Review this cycle.';
  }
  if (
    (state.status === 'running' || state.status === 'paused') &&
    !remainingCustomers(state).length &&
    !state.config?.rankTargets?.length &&
    // A repeat round finishes at the next claim, where the next one starts.
    !state.config?.repeat
  )
    state.status = 'completed';
  if (
    state.config?.timingMode === 'humanized' &&
    !cycle.error &&
    cycle.differenceCents === 0 &&
    cycle.bonusDifferenceCents === 0
  ) {
    const schedule = state.schedules?.find(
      (row) => row.customerId === cycle.customerId,
    );
    if (schedule) {
      const clock = playerClock(state, now);
      recordHumanizedCycle(schedule.humanized, clock.now, random, {
        spend: cycle.costCents ?? 0,
        value: cycle.saleCents ?? 0,
      });
      const plan = planHumanized(schedule.humanized, clock.now, random);
      schedule.nextRunAt = now + clock.toRealMs(plan.delayMs);
      schedule.waitReason = plan.reason;
    }
  }
  state.nextRunAt = null;
  if (state.status === 'running' && state.config) {
    if (state.config.timingMode === 'humanized') {
      const remaining = new Set(remainingCustomers(state));
      const due =
        state.schedules
          ?.filter((row) => remaining.has(row.customerId))
          .map((row) => row.nextRunAt) ?? [];
      state.nextRunAt = Math.max(
        now + 2000,
        due.length ? Math.min(...due) : now + 2000,
      );
    } else {
      state.nextRunAt =
        now +
        automationDelayMs(
          {
            timingMode:
              state.config.timingMode ?? DEFAULT_LIVE_TIMING.timingMode,
            fixedIntervalSeconds: state.config.intervalSeconds,
            randomMinSeconds:
              state.config.randomMinSeconds ??
              DEFAULT_LIVE_TIMING.randomMinSeconds,
            randomMaxSeconds:
              state.config.randomMaxSeconds ??
              DEFAULT_LIVE_TIMING.randomMaxSeconds,
          },
          random,
        );
    }
    if (state.config.rankTargets?.length) {
      if (state.config.timingMode !== 'humanized')
        state.nextDrawAt = state.nextRunAt;
      const goal = state.rankGoals?.find(
        (row) => row.target.profileId === cycle.customerId,
      );
      if (goal) goal.nextCheckAt = now + 2000;
      state.nextRunAt = Math.min(
        state.nextRunAt,
        Math.max(now + 2000, nextLiveRankCheck(state, now)),
      );
    }
  }
}

export function validateLiveConfig(
  value: unknown,
  allowedIds: string[],
): LiveConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provide live run settings.');
  const input: Record<string, unknown> = { ...DEFAULT_LIVE_TIMING, ...value };
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'packSlug',
          'customerIds',
          'intervalSeconds',
          'maxCyclesPerAccount',
          'maxSpendMyr', // Accepted from older clients, discarded below.
          'timingMode',
          'randomMinSeconds',
          'randomMaxSeconds',
          'humanizedRegion',
          'humanizedPace',
          'packMix',
          'rankTargets',
          'repeat',
        ].includes(key),
    ) ||
    (input.repeat !== undefined && typeof input.repeat !== 'boolean') ||
    typeof input.packSlug !== 'string' ||
    !(
      SLUG.test(input.packSlug) ||
      (input.packMix !== undefined && input.packSlug === '')
    ) ||
    !Number.isInteger(input.humanizedPace) ||
    Number(input.humanizedPace) < 1 ||
    Number(input.humanizedPace) > 24 ||
    !Array.isArray(input.customerIds) ||
    input.customerIds.length < 1 ||
    input.customerIds.length > 80 ||
    input.customerIds.some(
      (id) =>
        typeof id !== 'string' ||
        !id.startsWith('cus_') ||
        !allowedIds.includes(id),
    ) ||
    new Set(input.customerIds).size !== input.customerIds.length ||
    !Number.isInteger(input.intervalSeconds) ||
    Number(input.intervalSeconds) < 2 ||
    Number(input.intervalSeconds) > 86400 ||
    !Number.isInteger(input.maxCyclesPerAccount) ||
    Number(input.maxCyclesPerAccount) < 1 ||
    Number(input.maxCyclesPerAccount) > 10 ||
    typeof input.timingMode !== 'string' ||
    !['fixed', 'random', 'humanized'].includes(input.timingMode) ||
    typeof input.humanizedRegion !== 'string' ||
    !['mysg', 'global'].includes(input.humanizedRegion) ||
    ![input.randomMinSeconds, input.randomMaxSeconds].every(
      (number) =>
        Number.isInteger(number) &&
        Number(number) >= 2 &&
        Number(number) <= 86400,
    ) ||
    Number(input.randomMinSeconds) > Number(input.randomMaxSeconds)
  )
    throw new Error(
      'Choose a paid pack, 1–80 monitored customers, Fixed/Random/Humanized timing, 2–86400 second intervals with minimum no greater than maximum, a supported region, Humanized speed 1–24× and 1–10 cycles per account.',
    );
  return {
    packSlug: input.packSlug,
    ...(input.packMix === undefined
      ? {}
      : { packMix: validateLivePackMix(input.packMix) }),
    customerIds: [...input.customerIds],
    intervalSeconds: input.intervalSeconds,
    maxCyclesPerAccount: input.maxCyclesPerAccount,
    timingMode: input.timingMode,
    randomMinSeconds: input.randomMinSeconds,
    randomMaxSeconds: input.randomMaxSeconds,
    humanizedRegion: input.humanizedRegion,
    humanizedPace: input.humanizedPace,
    ...(input.repeat ? { repeat: true } : {}),
    ...(input.rankTargets === undefined
      ? {}
      : {
          rankTargets: validateLiveRankTargets(
            input.rankTargets,
            input.customerIds,
          ),
        }),
  } as unknown as LiveConfig;
}

/** Why a claimed account may not draw now, or null when it may. Checked
 *  before any money moves. Each read runs only once the earlier ones let
 *  the account through, and a read that throws stops the check. */
export async function liveAccountRefusal(account: {
  selected(): Promise<boolean>;
  disabled(): Promise<boolean>;
  frozen(): Promise<boolean>;
}): Promise<string | null> {
  if (!(await account.selected()) || (await account.disabled()))
    return 'Account is no longer selected or is disabled.';
  if (await account.frozen()) return 'Account is frozen.';
  return null;
}

/** The pack this draw opens and its fixed price, picked before the balance
 *  check. `skipped` means the wallet cannot cover it: one empty wallet must
 *  not stop the other accounts, so it only ends this account's draws. */
export function planLiveDraw(
  config: Pick<LiveConfig, 'packSlug' | 'packMix'>,
  pricesCents: Record<string, number>,
  balanceCents: number,
  random: () => number = timingRandom,
): { packSlug: string; priceCents: number; skipped?: string } {
  const packSlug = config.packMix
    ? pickLivePack(config.packMix, pricesCents, balanceCents, random)
    : config.packSlug;
  const priceCents = pricesCents[packSlug];
  if (balanceCents < priceCents)
    return {
      packSlug,
      priceCents,
      skipped: `Balance RM ${(balanceCents / 100).toFixed(2)} cannot cover RM ${(priceCents / 100).toFixed(2)}. No more draws for this account in this run.`,
    };
  return { packSlug, priceCents };
}

/** What one live cycle needs from the store, the workflows and the event bus. */
export interface LiveCycleDeps {
  /** The claimed cycle. Checkpoints write into it, and the caller completes it. */
  cycle: LiveCycle;
  packSlug: string;
  creditSummary(
    customerId: string,
  ): Promise<{ balance: number; bonusBalance: number }>;
  isAccountDisabled(customerId: string): Promise<boolean>;
  openPack(input: {
    customer_id: string;
    pack_id: string;
    open_id: string;
    max_price: number;
  }): Promise<{
    pull: { id: string };
    card: { name: string; handle: string };
    price: number;
    bonus_cents: number;
  }>;
  revealPull(
    pullId: string,
    customerId: string,
  ): Promise<{ first_reveal: boolean }>;
  emit(event: {
    name: 'pull.revealed';
    data: {
      pull_id: string;
      pack_id: string;
      card_id: string;
      customer_id: string;
    };
  }): Promise<unknown>;
  buyback(input: {
    customer_id: string;
    pull_id: string;
  }): Promise<{ amount: number }>;
  warn(message: string): void;
  /** Saves the cycle as the pending row, if this run still owns it. */
  persist(): Promise<void>;
}

/** The live adapter executeLiveCycle runs against. */
export function liveCycleServices(deps: LiveCycleDeps): LiveCycleServices {
  const { cycle, packSlug } = deps;
  return {
    balance: () => deps.creditSummary(cycle.customerId),
    open: async (customerId, openId, maxPrice) => {
      const result = await deps.openPack({
        customer_id: customerId,
        pack_id: packSlug,
        open_id: openId,
        max_price: maxPrice,
      });
      // Only this newly committed draw is revealed; never scan past cycles.
      try {
        const revealed = await deps.revealPull(result.pull.id, customerId);
        if (revealed.first_reveal) {
          await deps.emit({
            name: 'pull.revealed',
            data: {
              pull_id: result.pull.id,
              pack_id: packSlug,
              card_id: result.card.handle,
              customer_id: customerId,
            },
          });
        }
      } catch (error) {
        // An announcement failure must not interrupt the paid draw's settlement.
        deps.warn(
          `Live automation announcement dropped for pull ${result.pull.id}: ${
            error instanceof Error ? error.message : 'reveal unavailable'
          }`,
        );
      }
      return {
        pullId: result.pull.id,
        cardName: result.card.name,
        price: result.price,
        bonusUsed: result.bonus_cents / 100,
      };
    },
    checkpoint: async (result) => {
      Object.assign(cycle, result);
      await deps.persist();
    },
    sell: async (customerId, pullId) => {
      if (await deps.isAccountDisabled(customerId))
        throw new Error(
          'Account was disabled before settlement. The paid card remains in the vault.',
        );
      return deps.buyback({ customer_id: customerId, pull_id: pullId });
    },
  };
}

export interface LiveCycleServices {
  balance(): Promise<{ balance: number; bonusBalance: number }>;
  open(
    customerId: string,
    openId: string,
    maxPrice: number,
  ): Promise<{
    pullId: string;
    cardName: string;
    price: number;
    bonusUsed: number;
  }>;
  checkpoint(result: LiveCycleAmounts): Promise<void>;
  sell(customerId: string, pullId: string): Promise<{ amount: number }>;
}

export async function executeLiveCycle(
  customerId: string,
  openId: string,
  maxPrice: number,
  services: LiveCycleServices,
): Promise<LiveCycleAmounts> {
  const before = await services.balance();
  const opened = await services.open(customerId, openId, maxPrice);
  const result: LiveCycleAmounts = {
    pullId: opened.pullId,
    cardName: opened.cardName,
    costCents: Math.round(opened.price * 100),
    startingCents: Math.round(before.balance * 100),
    startingBonusCents: Math.round(before.bonusBalance * 100),
  };
  await services.checkpoint(result);
  const sold = await services.sell(customerId, opened.pullId);
  const after = await services.balance();
  result.saleCents = Math.round(sold.amount * 100);
  result.endingCents = Math.round(after.balance * 100);
  result.expectedCents =
    result.startingCents - result.costCents + result.saleCents;
  result.differenceCents = result.endingCents - result.expectedCents;
  result.endingBonusCents = Math.round(after.bonusBalance * 100);
  result.expectedBonusCents =
    result.startingBonusCents - Math.round(opened.bonusUsed * 100);
  result.bonusDifferenceCents =
    result.endingBonusCents - result.expectedBonusCents;
  if (
    ![
      result.costCents,
      result.saleCents,
      result.endingCents,
      result.expectedCents,
      result.differenceCents,
      result.endingBonusCents,
      result.expectedBonusCents,
      result.bonusDifferenceCents,
    ].every(Number.isSafeInteger)
  )
    throw new Error(
      'Invalid live ledger amounts. Review this cycle before starting another run.',
    );
  return result;
}
