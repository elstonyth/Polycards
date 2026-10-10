import type { AdminAuditRow } from './service';

// Config-change trail (2026-09-30). Pure builders for the admin_action_audit
// rows written when an operator changes a pack, its odds, a card's pack
// membership or a player group's odds set — so the odds and the buyback rate
// in force at any past moment can be read back instead of inferred from sales.
//
// The pack/odds workflows write these rows as their LAST step: a failed audit
// rolls the change back, so a change without a record cannot happen.

/** These screens have no reason field, so the row says where it came from. */
export const CONFIG_AUDIT_REASON = 'Saved in the admin (automatic entry)';

/** One card row of a pack's odds as stored — every column that decides a
 *  draw (weights per set, lock, tier) or its display (Top Hits order). */
export type OddsSnapshotRow = {
  card_id: string;
  rarity: string;
  weight: number;
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
  top_hit_order: number | null;
};

type OddsLike = {
  card_id: string | null;
  rarity?: string | null;
  weight: number;
  weight_2?: number | null;
  weight_3?: number | null;
  locked: boolean;
  top_hit_order?: number | null;
};

/** A pack's card pool as it stood — wrapped in an object because the audit
 *  columns are json objects, not arrays. Sorted so two snapshots diff cleanly. */
export function oddsSnapshot(rows: readonly OddsLike[]): {
  odds: OddsSnapshotRow[];
} {
  return {
    odds: rows
      .filter((r): r is OddsLike & { card_id: string } => r.card_id != null)
      .map((r) => ({
        card_id: r.card_id,
        // A legacy NULL tier draws as Common (roll-pack) — record what applied.
        rarity: r.rarity ?? 'Common',
        weight: r.weight,
        weight_2: r.weight_2 ?? null,
        weight_3: r.weight_3 ?? null,
        locked: r.locked,
        top_hit_order: r.top_hit_order ?? null,
      }))
      .sort((a, b) =>
        a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0,
      ),
  };
}

export type PackConfig = {
  slug: string;
  title: string;
  category: string;
  status: string;
  in_stock: boolean;
  price: number;
  buyback_percent: number;
  target_rtp_bps: number;
  boost: boolean;
  rank: number;
  image: string;
  display_image: string | null;
  published_odds: Record<string, unknown> | null;
  tier_ranges: Record<string, unknown> | null;
};

type PackLike = {
  slug: string;
  title: string;
  category: string;
  status: string;
  in_stock?: boolean | null;
  price: unknown;
  buyback_percent: number;
  target_rtp_bps?: number | null;
  boost: boolean;
  rank: number;
  image: string;
  display_image?: string | null;
  published_odds?: Record<string, unknown> | null;
  tier_ranges?: Record<string, unknown> | null;
};

/** The pack's operator-set configuration — price, instant buyback %, target
 *  RTP, status, published odds — and nothing else (no ids or timestamps). */
export function packConfig(p: PackLike): PackConfig {
  return {
    slug: p.slug,
    title: p.title,
    category: p.category,
    status: p.status,
    in_stock: p.in_stock ?? true,
    // bigNumber columns can come back as strings.
    price: Number(p.price),
    buyback_percent: p.buyback_percent,
    target_rtp_bps: p.target_rtp_bps ?? 7000,
    boost: p.boost,
    rank: p.rank,
    image: p.image,
    display_image: p.display_image ?? null,
    published_odds: p.published_odds ?? null,
    tier_ranges: p.tier_ranges ?? null,
  };
}

// JSON with object keys sorted at every level, so two snapshots of the same
// config compare equal whatever order the DB or the form produced the keys in.
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : v;

/** True when two snapshots describe the same configuration — a save that
 *  changed nothing writes no audit row. */
export const sameConfig = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** The audit row itself. Refuses a missing actor: an unattributed config
 *  change is exactly what this trail exists to rule out. */
export function configAuditRow(input: {
  adminId: string;
  entityType: AdminAuditRow['entity_type'];
  entityId: string;
  action: AdminAuditRow['action'];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): AdminAuditRow {
  if (!input.adminId) {
    throw new Error('configAuditRow: an acting admin id is required');
  }
  return {
    admin_id: input.adminId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    action: input.action,
    before: input.before,
    after: input.after,
    reason: CONFIG_AUDIT_REASON,
  };
}
