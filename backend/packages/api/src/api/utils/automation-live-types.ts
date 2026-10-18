export interface LiveConfig {
  packSlug: string;
  customerIds: string[];
  intervalSeconds: number;
  maxCyclesPerAccount: number;
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
  pending: LiveCycle | null;
  cycles: LiveCycle[];
  error: string | null;
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
