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
} as const;

export interface LiveConfig {
  packSlug: string;
  customerIds: string[];
  intervalSeconds: number;
  maxCyclesPerAccount: number;
  timingMode?: 'fixed' | 'random' | 'humanized';
  randomMinSeconds?: number;
  randomMaxSeconds?: number;
  humanizedRegion?: 'mysg' | 'global';
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
  packPriceCents: number;
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
