import type { AutomationConfig } from './automation-types';
import type {
  HumanizedAssignment,
  HumanizedState,
} from './automation-humanized';
import type { RankRuntime } from './automation-rank';

export interface SandboxProfile {
  id: string;
  name: string;
  balanceCents: number;
  bonusCents: number;
  allTimeValueCents: number;
  allTimePulls: number;
  weekly: { key: string; valueCents: number; pulls: number };
}

export interface SandboxCycle {
  at: number;
  cardName: string;
  costCents: number;
  saleCents: number;
  startingCents: number;
  endingCents: number;
  expectedCents: number;
  differenceCents: number;
  startingBonusCents: number;
  endingBonusCents: number;
  expectedBonusCents: number;
  bonusDifferenceCents: number;
}

export interface SandboxResult {
  profileId: string;
  profileName: string;
  status: 'queued' | 'waiting' | 'completed' | 'failed' | 'stopped';
  cycles: SandboxCycle[];
  nextRunAt: number | null;
  scheduleLabel: string | null;
  waitReason: string | null;
  error: string | null;
  humanized: HumanizedState | null;
  rank: RankRuntime | null;
}

export interface SandboxState {
  version: 1;
  mode: 'sandbox';
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  config: AutomationConfig;
  selectedProfileIds: string[];
  profiles: SandboxProfile[];
  results: SandboxResult[];
  humanizedAssignments?: HumanizedAssignment[];
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  nextRunAt: number | null;
  clockAt: number | null;
  spentCents: number;
  completedCycles: number;
  error: string | null;
}

export interface SandboxEntry {
  rank: number;
  profileId: string;
  name: string;
  valueCents: number;
  pulls: number;
}

export interface SandboxSnapshot extends SandboxState {
  leaderboards: { weekly: SandboxEntry[]; alltime: SandboxEntry[] };
}
