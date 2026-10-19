import type {
  HumanizedAssignment,
  HumanizedState,
} from './automation-humanized';
import type { RankRuntime } from './automation-rank';

export interface LiveRankTarget {
  customerId: string;
  period: 'weekly' | 'alltime';
  targetRank: number;
}

export interface LiveRankGoal extends RankRuntime {
  done: boolean;
  nextCheckAt: number;
  observationExpiresAt: number;
}

export const DEFAULT_LIVE_TIMING = {
  timingMode: 'fixed',
  randomMinSeconds: 2,
  randomMaxSeconds: 5,
  humanizedRegion: 'mysg',
  humanizedPace: 1,
} as const;

/** One pack in a weighted mix; weightBp is hundredths of a percent (250 = 2.5%). */
export interface LivePackWeight {
  packSlug: string;
  weightBp: number;
}

export interface LiveConfig {
  packSlug: string;
  /** When set, each draw picks a pack by weight instead of packSlug. */
  packMix?: LivePackWeight[];
  customerIds: string[];
  intervalSeconds: number;
  maxCyclesPerAccount: number;
  timingMode?: 'fixed' | 'random' | 'humanized';
  randomMinSeconds?: number;
  randomMaxSeconds?: number;
  humanizedRegion?: 'mysg' | 'global';
  /** 1 = desktop timing; N divides in-session waits by N and allows N× draws per session. */
  humanizedPace?: number;
  rankTargets?: LiveRankTarget[];
}

export interface LiveSchedule {
  customerId: string;
  humanized: HumanizedState;
  nextRunAt: number;
  waitReason: string;
}

export interface LiveCycleAmounts {
  pullId: string;
  cardName: string;
  costCents: number;
  saleCents?: number;
  startingCents: number;
  startingBonusCents: number;
  endingCents?: number;
  expectedCents?: number;
  differenceCents?: number;
  endingBonusCents?: number;
  expectedBonusCents?: number;
  bonusDifferenceCents?: number;
}

export interface LiveCycle extends Partial<LiveCycleAmounts> {
  id: string;
  customerId: string;
  packSlug?: string;
  /** Why the account was skipped before any money moved (e.g. low balance). */
  skipped?: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface LiveState {
  version: 1;
  mode: 'live';
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  config: LiveConfig | null;
  runId: string | null;
  /** Single pack price, or the mix's weighted average (rank goal estimates). */
  packPriceCents: number;
  /** Price per pack the run may open, fixed at save/run (each open's max_price). */
  packPricesCents?: Record<string, number>;
  spentCents: number;
  nextRunAt: number | null;
  nextDrawAt?: number;
  pending: LiveCycle | null;
  cycles: LiveCycle[];
  error: string | null;
  schedules?: LiveSchedule[];
  humanizedAssignments?: HumanizedAssignment[];
  rankGoals?: LiveRankGoal[];
}

export interface LiveSnapshot extends LiveState {
  packs: { slug: string; title: string; price: number }[];
  accounts: {
    id: string;
    name: string;
    balance: number | null;
    status: string;
  }[];
}
