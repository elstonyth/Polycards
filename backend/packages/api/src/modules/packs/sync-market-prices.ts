import { priceFieldForGrade } from './pricecharting-grades';

// Money guardrails (audit 2026-07-07 #3). market_value feeds real-credit
// buyback, so a glitched upstream value must never land silently:
// - MAX_MARKET_VALUE_USD: absolute ceiling — no single card is worth more.
// - MAX_SYNC_DELTA_RATIO: larger moves need two consistent observations at
//   least 24 hours apart. Pending quotes/errors surface in admin pricing health.
export const MAX_MARKET_VALUE_USD = 100_000;
export const MAX_SYNC_DELTA_RATIO = 5;
const CONFIRMATION_MS = 24 * 60 * 60 * 1000;

export type PendingCardPrice = {
  product_id: string;
  grade: string;
  baseline_value: number;
  proposed_value: number;
  first_seen_at: string;
};

// Daily PriceCharting sync core (Task 8). Pure function, no DB/HTTP directly —
// the job wrapper (src/jobs/sync-market-prices.ts) supplies pcFetch/updateCards
// so this stays unit-testable with mocks. Never writes a null/zero/NaN
// market_value: any unusable upstream result skips and keeps the last-known
// value (guardrail — this is money-adjacent).
type PcRes =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'no-token' }
  | { kind: 'error'; message: string };

export type CardPriceUpdate = {
  id: string;
  market_value?: number;
  pc_synced_at?: Date;
  pc_pending_price: PendingCardPrice | null;
  pc_sync_error: string | null;
};

export type RefreshDeps = {
  pcFetch: (path: string, params: Record<string, string>) => Promise<PcRes>;
  // Must compare the observed card state atomically; false means another edit won.
  updateCards: (u: [CardPriceUpdate]) => Promise<boolean>;
  now: Date;
};

export type CardRow = {
  id: string;
  handle: string;
  pc_product_id: string | null;
  pc_grade: string | null;
  market_value: number;
  pc_pending_price?: Record<string, unknown> | null;
  pc_sync_error?: string | null;
};

// Stored observations are JSON; reject stale links/baselines and malformed data.
export function pendingPriceFor(
  card: Pick<
    CardRow,
    'pc_product_id' | 'pc_grade' | 'market_value' | 'pc_pending_price'
  >,
): PendingCardPrice | null {
  const p = card.pc_pending_price;
  if (
    !p ||
    !card.pc_product_id ||
    !card.pc_grade ||
    p.product_id !== card.pc_product_id ||
    p.grade !== card.pc_grade ||
    p.baseline_value !== Number(card.market_value) ||
    typeof p.proposed_value !== 'number' ||
    !Number.isFinite(p.proposed_value) ||
    p.proposed_value <= 0 ||
    p.proposed_value > MAX_MARKET_VALUE_USD ||
    typeof p.first_seen_at !== 'string' ||
    !Number.isFinite(Date.parse(p.first_seen_at))
  )
    return null;
  return p as PendingCardPrice;
}

export type RefreshResult = {
  handle: string;
  oldValue: number;
  newValue: number;
  changed: boolean;
  skippedReason?: string;
};

// Append the FMV history trail for one sync result by comparing the LATEST
// history row to the card's current value (not a boolean "any history?" probe):
// - first sync (no rows)            → baseline row
// - value changed this run          → change row
// - latest row ≠ current value      → self-heals a gap left by a failed insert
//                                     on a previous run (card update committed,
//                                     history didn't — audit 2026-07-07 M2)
// - re-run / concurrent run, in-sync → no duplicate
// ponytail: a concurrent duplicate insert of the SAME value in the same second
// is still possible (two backends, no job lock) and harmless to the curve.
export async function recordPriceHistory(
  packs: {
    listCardPriceHistories: (
      f: { card_id: string },
      c: {
        take: number;
        order?: Record<string, 'ASC' | 'DESC'>;
      },
    ) => Promise<Array<{ value: unknown }>>;
    createCardPriceHistories: (
      rows: Array<{ card_id: string; value: number }>,
    ) => Promise<unknown>;
  },
  cardId: string,
  r: RefreshResult,
): Promise<void> {
  if (r.skippedReason) return;
  const [latest] = await packs.listCardPriceHistories(
    { card_id: cardId },
    { take: 1, order: { created_at: 'DESC', id: 'DESC' } },
  );
  if (!latest || Number(latest.value) !== r.newValue) {
    await packs.createCardPriceHistories([
      { card_id: cardId, value: r.newValue },
    ]);
  }
}

export async function refreshCardPrice(
  card: CardRow,
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const oldValue = Number(card.market_value);
  const base = {
    handle: card.handle,
    oldValue,
    newValue: oldValue,
    changed: false as boolean,
  };
  const superseded = {
    ...base,
    skippedReason: 'card changed during price check',
  };
  const skip = async (reason: string): Promise<RefreshResult> => {
    const applied = await deps.updateCards([
      { id: card.id, pc_pending_price: null, pc_sync_error: reason },
    ]);
    return applied ? { ...base, skippedReason: reason } : superseded;
  };
  if (!card.pc_product_id || !card.pc_grade) return skip('not linked');
  const field = priceFieldForGrade(card.pc_grade);
  if (!field) return skip(`unknown grade '${card.pc_grade}'`);
  if (!Number.isFinite(oldValue) || oldValue < 0)
    return skip('invalid stored market value');
  const res = await deps.pcFetch('/api/product', { id: card.pc_product_id });
  if (res.kind !== 'ok')
    return skip(res.kind === 'no-token' ? 'no token' : res.message);
  if (String(res.data.id) !== card.pc_product_id)
    return skip('PriceCharting product identity mismatch');
  const pennies = res.data[field];
  if (
    typeof pennies !== 'number' ||
    !Number.isSafeInteger(pennies) ||
    pennies <= 0
  ) {
    return skip('no usable price');
  }
  const newValue = Math.round(pennies) / 100;
  if (newValue > MAX_MARKET_VALUE_USD) {
    return skip(`above cap: ${newValue} > ${MAX_MARKET_VALUE_USD}`);
  }
  if (
    oldValue > 0 &&
    (newValue > oldValue * MAX_SYNC_DELTA_RATIO ||
      newValue < oldValue / MAX_SYNC_DELTA_RATIO)
  ) {
    const pending = pendingPriceFor(card);
    const firstSeen = pending ? Date.parse(pending.first_seen_at) : NaN;
    // Compare integer cents so the inclusive 10% boundary is deterministic.
    const consistent =
      pending &&
      firstSeen <= deps.now.getTime() &&
      Math.abs(pennies - Math.round(pending.proposed_value * 100)) * 10 <=
        Math.round(pending.proposed_value * 100);
    if (!consistent || deps.now.getTime() - firstSeen < CONFIRMATION_MS) {
      const applied = await deps.updateCards([
        {
          id: card.id,
          pc_pending_price: consistent
            ? pending
            : {
                product_id: card.pc_product_id,
                grade: card.pc_grade,
                baseline_value: oldValue,
                proposed_value: newValue,
                first_seen_at: deps.now.toISOString(),
              },
          pc_sync_error: null,
        },
      ]);
      if (!applied) return superseded;
      return {
        ...base,
        skippedReason: `anomalous change ${oldValue} -> ${newValue} (>${MAX_SYNC_DELTA_RATIO}x), awaiting confirmation`,
      };
    }
  }
  const applied = await deps.updateCards([
    {
      id: card.id,
      market_value: newValue,
      pc_synced_at: deps.now,
      pc_pending_price: null,
      pc_sync_error: null,
    },
  ]);
  if (!applied) return superseded;
  return {
    handle: card.handle,
    oldValue,
    newValue,
    changed: newValue !== oldValue,
  };
}
