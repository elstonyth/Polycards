// Deterministic fingerprint of the box editor buffer, used to detect unsaved
// edits before a tier/tab switch discards them. localId is excluded on purpose
// (it is regenerated on every seed).
export interface BoxBufferState {
  name: string;
  enabled: boolean;
  drawsPerDay: string;
  rows: Array<{
    kind: string;
    amountInput: string;
    productHandle: string | null;
    qtyInput: string;
    locked: boolean;
    pctInput: string;
  }>;
}

export const snapshotOf = (s: BoxBufferState): string =>
  JSON.stringify({
    name: s.name,
    enabled: s.enabled,
    draws: s.drawsPerDay,
    rows: s.rows.map((r) => ({
      kind: r.kind,
      amount: r.amountInput,
      product: r.productHandle,
      qty: r.qtyInput,
      locked: r.locked,
      pct: r.pctInput,
    })),
  });
