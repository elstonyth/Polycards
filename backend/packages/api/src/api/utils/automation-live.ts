import { randomUUID } from 'node:crypto';
import type {
  LiveConfig,
  LiveCycle,
  LiveCycleAmounts,
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
  };
}

export function claimLiveCycle(
  state: LiveState,
  now: number,
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
  const { config } = state;
  const customerId = config.customerIds.find(
    (id) =>
      state.cycles.filter((cycle) => cycle.customerId === id).length <
      config.maxCyclesPerAccount,
  );
  if (
    !customerId ||
    state.spentCents + state.packPriceCents >
      Math.round(config.maxSpendMyr * 100)
  ) {
    state.status = 'completed';
    state.nextRunAt = null;
    return null;
  }
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
): void {
  if (state.pending?.id !== cycle.id)
    throw new Error('Live cycle ownership changed. Review the ledger.');
  state.cycles.push({ ...cycle, finishedAt: now });
  state.spentCents += cycle.costCents ?? 0;
  state.pending = null;
  if (
    cycle.error ||
    cycle.differenceCents !== 0 ||
    cycle.bonusDifferenceCents !== 0
  ) {
    state.status = 'failed';
    state.error =
      cycle.error ??
      'Balance verification differs from the expected settlement. Review this cycle.';
  }
  state.nextRunAt =
    state.status === 'running' && state.config
      ? now + state.config.intervalSeconds * 1000
      : null;
}

export function validateLiveConfig(
  value: unknown,
  allowedIds: string[],
): LiveConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provide live run settings.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'packSlug',
          'customerIds',
          'intervalSeconds',
          'maxCyclesPerAccount',
          'maxSpendMyr',
        ].includes(key),
    ) ||
    typeof input.packSlug !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(input.packSlug) ||
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
    typeof input.maxSpendMyr !== 'number' ||
    !Number.isFinite(input.maxSpendMyr) ||
    input.maxSpendMyr < 0.01 ||
    input.maxSpendMyr > 8000 ||
    Math.abs(input.maxSpendMyr * 100 - Math.round(input.maxSpendMyr * 100)) >
      0.000001
  )
    throw new Error(
      'Choose a paid pack, 1–80 monitored customer accounts, 2–86400 seconds, 1–10 cycles and a spend limit up to RM8,000 (two decimals).',
    );
  return {
    ...input,
    customerIds: [...input.customerIds],
  } as unknown as LiveConfig;
}

interface LiveCycleServices {
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
