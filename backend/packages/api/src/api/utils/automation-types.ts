export interface AutomationConfig {
  timingMode: 'fixed' | 'random' | 'humanized';
  fixedIntervalSeconds: number;
  randomMinSeconds: number;
  randomMaxSeconds: number;
  maxCyclesPerProfile: number;
  maxTotalSpend: number;
  humanizedRegion: 'mysg' | 'global';
  humanizedTestClock?: boolean;
  rankTargets?: AutomationRankTarget[];
}

export interface AutomationRankTarget {
  profileId: string;
  period: 'weekly' | 'alltime';
  mode: 'monitor' | 'shadow' | 'test' | 'live';
  goal: 'reach' | 'maintain';
  targetRank: number;
  secureBufferMyr: number;
  threatBufferMyr: number;
  maxCycles: number;
  maxSpendMyr: number;
  maxDurationMinutes: number;
}

export interface AutomationRankStatus {
  state: string;
  reason: string;
  period: AutomationRankTarget['period'];
  mode: AutomationRankTarget['mode'];
  targetRank: number;
  currentRank: number | null;
  pulledValueMyr: number | null;
  gapMyr: number | null;
  leadMyr: number | null;
  observedAt: string | null;
  wouldDraw: boolean;
  eligible: boolean;
  events: { at: string; type: string; message: string }[];
  stopReason?: string;
}
