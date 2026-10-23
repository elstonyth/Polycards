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
  /** Humanized clock speed, 1–24: the players' whole day (sessions, breaks, sleep) runs N× faster. */
  humanizedPace?: number;
  rankTargets?: LiveRankTarget[];
  /** Start the next round by itself when a round finishes (always-on runs). */
  repeat?: boolean;
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
  /** When the current run started (absent on runs started before it existed). */
  startedAt?: number;
  /** Humanized clock start, kept across repeated rounds so schedules carry on. */
  clockStartedAt?: number;
  /** Earlier runs, newest first, archived when the next run starts. */
  history?: LiveRunSummary[];
}

export interface LiveRunSummary {
  runId: string;
  startedAt: number | null;
  endedAt: number | null;
  status: LiveState['status'];
  draws: number;
  settled: number;
  failed: number;
  spentCents: number;
  soldCents: number;
  accounts: number;
  packSlugs: string[];
  timingMode: NonNullable<LiveConfig['timingMode']>;
}

/** GET /admin/automation/activity — house-account draws from the pull ledger. */
export interface AutomationActivity {
  windowDays: number;
  hitTiers: string[];
  names: Record<string, string>;
  days: {
    day: string;
    draws: number;
    valueMyr: number;
    costMyr: number;
    soldMyr: number;
  }[];
  tiers: { rarity: string; draws: number }[];
  accounts: {
    customerId: string;
    draws: number;
    valueMyr: number;
    costMyr: number;
    soldMyr: number;
    hits: number;
    lastAt: string;
  }[];
  hits: {
    id: string;
    customerId: string;
    rarity: string;
    cardName: string | null;
    cardImage: string | null;
    packTitle: string | null;
    valueMyr: number;
    sold: boolean;
    rolledAt: string;
  }[];
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
