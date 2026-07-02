import { priceFieldForGrade } from './pricecharting-grades';

// Daily PriceCharting sync core (Task 8). Pure function, no DB/HTTP directly —
// the job wrapper (src/jobs/sync-market-prices.ts) supplies pcFetch/updateCards
// so this stays unit-testable with mocks. Never writes a null/zero/NaN
// market_value: any unusable upstream result skips and keeps the last-known
// value (guardrail — this is money-adjacent).
type PcRes =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'no-token' }
  | { kind: 'error'; message: string };

export type RefreshDeps = {
  pcFetch: (path: string, params: Record<string, string>) => Promise<PcRes>;
  updateCards: (
    u: Array<{ id: string; market_value: number; pc_synced_at: Date }>,
  ) => Promise<unknown>;
  now: Date;
};

export type CardRow = {
  id: string;
  handle: string;
  pc_product_id: string | null;
  pc_grade: string | null;
  market_value: number;
};

export type RefreshResult = {
  handle: string;
  oldValue: number;
  newValue: number;
  changed: boolean;
  skippedReason?: string;
};

// Append the FMV history trail for one sync result: a row on every value
// change, plus one baseline row the first time a card syncs (so the curve has
// a starting point). Skipped syncs (no token / no usable price) never write.
// Shared by the daily job and the integration suite — packs is the module
// service (structurally typed so tests can pass the real service directly).
export async function recordPriceHistory(
  packs: {
    listCardPriceHistories: (
      f: { card_id: string },
      c: { take: number },
    ) => Promise<unknown[]>;
    createCardPriceHistories: (
      rows: Array<{ card_id: string; value: number }>,
    ) => Promise<unknown>;
  },
  cardId: string,
  r: RefreshResult,
): Promise<void> {
  if (r.skippedReason) return;
  const hasHistory =
    (await packs.listCardPriceHistories({ card_id: cardId }, { take: 1 }))
      .length > 0;
  if (r.changed || !hasHistory) {
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
  if (!card.pc_product_id || !card.pc_grade)
    return { ...base, skippedReason: 'not linked' };
  const field = priceFieldForGrade(card.pc_grade);
  if (!field)
    return { ...base, skippedReason: `unknown grade '${card.pc_grade}'` };
  const res = await deps.pcFetch('/api/product', { id: card.pc_product_id });
  if (res.kind !== 'ok')
    return {
      ...base,
      skippedReason: res.kind === 'no-token' ? 'no token' : res.message,
    };
  const pennies = res.data[field];
  if (
    typeof pennies !== 'number' ||
    !Number.isFinite(pennies) ||
    pennies <= 0
  ) {
    return { ...base, skippedReason: 'no usable price' };
  }
  const newValue = Math.round(pennies) / 100;
  await deps.updateCards([
    { id: card.id, market_value: newValue, pc_synced_at: deps.now },
  ]);
  return {
    handle: card.handle,
    oldValue,
    newValue,
    changed: newValue !== oldValue,
  };
}
