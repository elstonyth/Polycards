export type CoinFlipSettings = {
  enabled: boolean;
  win_percent: number | null;
  win_percent_2: number | null;
  win_percent_3: number | null;
  published_win_percent: number | null;
  revision: number;
};
const numericFields = [
  'win_percent',
  'win_percent_2',
  'win_percent_3',
  'published_win_percent',
] as const;
export type CoinFlipDraft = { enabled: boolean } & Record<
  (typeof numericFields)[number],
  string
>;
export function coinFlipDraft(settings: CoinFlipSettings): CoinFlipDraft {
  return {
    enabled: settings.enabled,
    win_percent: settings.win_percent?.toString() ?? '',
    win_percent_2: settings.win_percent_2?.toString() ?? '',
    win_percent_3: settings.win_percent_3?.toString() ?? '',
    published_win_percent: settings.published_win_percent?.toString() ?? '',
  };
}
export function parseCoinFlipDraft(
  draft: CoinFlipDraft,
): Omit<CoinFlipSettings, 'revision'> {
  const values = {
    enabled: draft.enabled,
    win_percent: null,
    win_percent_2: null,
    win_percent_3: null,
    published_win_percent: null,
  } as Omit<CoinFlipSettings, 'revision'>;
  for (const key of numericFields) {
    const raw = draft[key].trim();
    if (!raw) continue;
    const value = Number(raw);
    if (
      !/^\d+(\.\d{1,4})?$/.test(raw) ||
      !Number.isFinite(value) ||
      value > 100
    )
      throw new Error('Odds must be 0–100% with at most 4 decimal places.');
    values[key] = value;
  }
  if (
    draft.enabled &&
    (values.win_percent == null || values.published_win_percent == null)
  ) {
    throw new Error('Set actual set 1 and published odds before enabling.');
  }
  return values;
}
export const effectiveCoinRates = (
  settings: Omit<CoinFlipSettings, 'revision'>,
) => [
  settings.win_percent,
  settings.win_percent_2 ?? settings.win_percent,
  settings.win_percent_3 ?? settings.win_percent_2 ?? settings.win_percent,
];
export type CoinHistoryFilters = {
  page: number;
  status: '' | 'won' | 'lost';
  customer: string;
  from: string;
  to: string;
  source?: '' | 'pack' | 'bonus' | 'gift' | 'reward' | 'free' | 'mixed' | 'tickets';
};
export function coinHistoryQuery(filters: CoinHistoryFilters) {
  const page = Number.isSafeInteger(filters.page)
    ? Math.max(0, Math.min(10000, filters.page))
    : 0;
  const query = new URLSearchParams({ limit: '25', offset: String(page * 25) });
  if (filters.status) query.set('status', filters.status);
  if (filters.source) query.set('source', filters.source);
  if (filters.customer.trim())
    query.set('customer_id', filters.customer.trim());
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return query.toString();
}
export type AdminCoinRound = {
  id: string;
  status: 'won' | 'lost';
  customer_id: string;
  pull_id: string | null;
  stake_amount: number;
  win_amount: number;
  published_win_percent: number;
  settled_at: string;
  config_revision: number;
  roll: number;
  credit_transaction_id: string | null;
  chosen_side: 'head' | 'tail';
  landed_side: 'head' | 'tail';
  cards: { pull_id: string; name: string; stake_amount: number }[];
  /** Null when the flip stakes only `tickets`, which move no money. */
  card: {
    name: string;
    image: string | null;
    grader: string | null;
    grade: string | null;
  } | null;
  tickets: number;
  snapshot: {
    cards?: {
      card: { pull_id: string; name: string };
      stake_cents: number;
      source: string;
      bonus_bp: number;
      valuation: {
        value_usd: number;
        multiplier: number;
        fx: number;
        quoted_at: string;
      };
    }[];
    group_id: string | null;
    odds_set: 1 | 2 | 3;
    actual_win_units: number;
    published_win_units: number;
    source: string;
    bonus_bp: number;
    valuation?: {
      value_usd: number;
      multiplier: number;
      fx: number;
      quoted_at: string;
    };
  };
};
export type AdminCoinHistory = {
  rounds: AdminCoinRound[];
  count: number;
  limit: number;
  offset: number;
  totals: {
    wins: number;
    losses: number;
    payouts: number;
    forfeited_value: number;
  };
};
