import { weightedAverageCost, type CostLine } from './inventory-cost';

// The P&L report's pure folds (GET /admin/profit-report/pnl; spec
// plans/pnl-report/SPEC.md, decisions plans/pnl-report-decisions.md). Every
// amount is integer sen so the page's "vs previous" never drifts.

/** Where a free pack came from. `welcome` counts in qty at RM 0 (decision 20). */
export const FREE_SOURCES = [
  'adjustment',
  'checkin',
  'task',
  'welcome',
  'other',
] as const;
export type FreeSource = (typeof FREE_SOURCES)[number];

export type PackMeta = {
  slug: string;
  title: string;
  category: string | null;
  pack_type: string | null;
  prize_type: string | null;
  price_sen: number;
};

/** One window's raw pack rows. `paid` is keyed by slug; null = a pack_open
 *  charge linked to no pull or spin (pre-open_id rows). */
export type PackWindowRows = {
  paid: Map<string | null, { full_sen: number; bonus_sen: number }>;
  opens: Map<string, number>;
  free: { slug: string; source: FreeSource; qty: number }[];
};

export type PackFigures = {
  opens: number;
  /** Full price of paid opens: cash + the bonus-credit share. */
  paid_sen: number;
  /** The bonus-credit share of paid_sen (also "free credit used"). */
  bonus_sen: number;
  free_qty: Record<FreeSource, number>;
  free_sen: number;
  total_sen: number;
};

export type Pair = { current_sen: number; previous_sen: number | null };

export type PackRow<F> = {
  slug: string;
  title: string;
  price_sen: number;
  current: F;
  previous: F | null;
};

/** Franchise (pack.category) → type (pack.pack_type) → pack, with subtotals. */
export type PackTree<F> = {
  category: string | null;
  total: Pair;
  types: { pack_type: string | null; total: Pair; packs: PackRow<F>[] }[];
}[];

export type PackSalesSection = {
  total: Pair;
  unattributed: Pair;
  franchises: PackTree<PackFigures>;
};

// The owner's order (2026-11-15): Original, Special, Classic, then the rest.
const TYPE_ORDER = ['original', 'special', 'classic'];
const typeRank = (t: string | null) => {
  const i = t === null ? -1 : TYPE_ORDER.indexOf(t);
  return i === -1 ? TYPE_ORDER.length : i;
};

const zeroFree = (): Record<FreeSource, number> =>
  Object.fromEntries(FREE_SOURCES.map((s) => [s, 0])) as Record<
    FreeSource,
    number
  >;

function figures(
  slug: string,
  priceSen: number,
  w: PackWindowRows,
): PackFigures {
  const paid = w.paid.get(slug) ?? { full_sen: 0, bonus_sen: 0 };
  const free_qty = zeroFree();
  for (const f of w.free) if (f.slug === slug) free_qty[f.source] += f.qty;
  // Welcome packs count at RM 0 whatever the pack's price (decision 20), the
  // same rule as the marketing section, so the two always cancel (review F4).
  const paidFree = FREE_SOURCES.reduce(
    (n, s) => n + (s === 'welcome' ? 0 : free_qty[s]),
    0,
  );
  const free_sen = paidFree * priceSen;
  return {
    opens: w.opens.get(slug) ?? 0,
    paid_sen: paid.full_sen,
    bonus_sen: paid.bonus_sen,
    free_qty,
    free_sen,
    total_sen: paid.full_sen + free_sen,
  };
}

const active = (f: PackFigures | null) =>
  f !== null &&
  (f.opens !== 0 ||
    f.paid_sen !== 0 ||
    FREE_SOURCES.some((s) => f.free_qty[s] !== 0));

const addPair = (a: Pair, cur: number, prev: number | null): Pair => ({
  current_sen: a.current_sen + cur,
  previous_sen: a.previous_sen === null ? null : a.previous_sen + (prev ?? 0),
});

/** Every pack slug a window's rows name (unattributed charges excluded). */
export function slugsOf(...windows: (PackWindowRows | null)[]): string[] {
  const s = new Set<string>();
  for (const w of windows) {
    if (!w) continue;
    for (const k of w.paid.keys()) if (k !== null) s.add(k);
    for (const k of w.opens.keys()) s.add(k);
    for (const f of w.free) s.add(f.slug);
  }
  return [...s];
}

const metaOf = (bySlug: Map<string, PackMeta>, slug: string): PackMeta =>
  bySlug.get(slug) ?? {
    slug,
    title: slug,
    category: null,
    pack_type: null,
    prize_type: null,
    price_sen: 0,
  };

/** Group per-pack figures into the franchise → type → pack tree, owner's
 *  order. `figs` returns null to leave a pack out. */
function packTree<F extends { total_sen: number }>(
  meta: readonly PackMeta[],
  slugs: readonly string[],
  hasPrevious: boolean,
  figs: (m: PackMeta) => { current: F; previous: F | null } | null,
): { total: Pair; franchises: PackTree<F> } {
  const bySlug = new Map(meta.map((m) => [m.slug, m]));
  const empty: Pair = { current_sen: 0, previous_sen: hasPrevious ? 0 : null };
  let total = empty;
  const franchises = new Map<string | null, PackTree<F>[number]>();
  for (const slug of slugs) {
    const m = metaOf(bySlug, slug);
    const f = figs(m);
    if (!f) continue;
    let fr = franchises.get(m.category);
    if (!fr) {
      fr = { category: m.category, total: empty, types: [] };
      franchises.set(m.category, fr);
    }
    let ty = fr.types.find((t) => t.pack_type === m.pack_type);
    if (!ty) {
      ty = { pack_type: m.pack_type, total: empty, packs: [] };
      fr.types.push(ty);
    }
    ty.packs.push({ slug, title: m.title, price_sen: m.price_sen, ...f });
    const p = f.previous?.total_sen ?? null;
    ty.total = addPair(ty.total, f.current.total_sen, p);
    fr.total = addPair(fr.total, f.current.total_sen, p);
    total = addPair(total, f.current.total_sen, p);
  }
  const out = [...franchises.values()];
  for (const fr of out) {
    fr.types.sort(
      (a, b) =>
        typeRank(a.pack_type) - typeRank(b.pack_type) ||
        String(a.pack_type).localeCompare(String(b.pack_type)),
    );
    for (const ty of fr.types)
      ty.packs.sort(
        (a, b) => a.price_sen - b.price_sen || a.title.localeCompare(b.title),
      );
  }
  out.sort(
    (a, b) =>
      b.total.current_sen - a.total.current_sen ||
      String(a.category).localeCompare(String(b.category)),
  );
  return { total, franchises: out };
}

/** Pack sales by franchise → type → pack. Capsules (prize_type 'tickets') are
 *  left out: they belong to the Lucky Draw section. */
export function packSalesSection(
  meta: readonly PackMeta[],
  current: PackWindowRows,
  previous: PackWindowRows | null,
): PackSalesSection {
  const unattributed: Pair = {
    current_sen: current.paid.get(null)?.full_sen ?? 0,
    previous_sen: previous ? (previous.paid.get(null)?.full_sen ?? 0) : null,
  };
  const tree = packTree(meta, slugsOf(current, previous), !!previous, (m) => {
    if (m.prize_type === 'tickets') return null;
    const cur = figures(m.slug, m.price_sen, current);
    const prev = previous ? figures(m.slug, m.price_sen, previous) : null;
    return active(cur) || active(prev)
      ? { current: cur, previous: prev }
      : null;
  });
  return {
    total: addPair(
      tree.total,
      unattributed.current_sen,
      unattributed.previous_sen,
    ),
    unattributed,
    franchises: tree.franchises,
  };
}

// ── COGS (spec §6, decisions 1, 12, 17) ─────────────────────────────────────

/** One purchase-invoice line with its invoice's MYT day. */
export type DatedCostLine = CostLine & { day: string };

/** Weighted-average supplier cost (inventory-cost.ts) from the invoices dated
 *  on or before `day` (null = every invoice), so a closed month's shipped cost
 *  is not moved by later invoices. A card with no invoice by then falls back to
 *  every invoice, so a late-booked invoice still replaces a market estimate. */
export function costAsOf(
  lines: readonly DatedCostLine[],
  day: string | null,
): number | null {
  const all = weightedAverageCost([...lines]);
  if (day === null) return all;
  return weightedAverageCost(lines.filter((l) => l.day <= day)) ?? all;
}

/** One saved USD_MYR rate per MYT day (fx_rate_day), oldest first. */
export type DayRate = { day: string; rate: number };

/** The day's saved rate, else the nearest earlier saved day, else `fallback`
 *  (the current effective rate: history starts when fx_rate_day shipped). */
export function rateOn(
  day: string,
  rates: readonly DayRate[],
  fallback: number,
): number {
  let found = fallback;
  for (const r of rates) {
    if (r.day > day) break;
    found = r.rate;
  }
  return found;
}

/** One window's raw COGS rows. Reward CARDS (reward pulls with no pack row)
 *  are already left out by the queries (decision 12). */
export type CogsWindowRows = {
  /** Buyback credit paid, sen, by the pull's pack. */
  buyback: Map<string, number>;
  /** Card value pulled (draw-time snapshot, else live), USD, by pack and MYT day. */
  pulled: { slug: string; day: string; usd: number; n: number }[];
  /** Cards shipped (order shipped or completed), by pack, card and ship day. */
  shipped: {
    slug: string;
    handle: string;
    day: string;
    n: number;
    market_usd: number | null;
  }[];
  /** Supplier purchase invoices dated in the window, sen (information). */
  purchase_sen: number;
};

/** A card's supplier cost in RM as of a ship day, null when it has none. */
export type CostOf = (handle: string, day: string) => number | null;

export type CogsFigures = {
  pulls: number;
  /** Information only, not in total_sen. */
  pulled_sen: number;
  buyback_sen: number;
  shipped_cards: number;
  /** Weighted-average supplier cost; estimated cards at market × day rate. */
  shipped_cost_sen: number;
  estimated_cards: number;
  total_sen: number;
};

export type CogsSection = {
  total: Pair;
  pulled: Pair;
  purchase: Pair;
  /** Shipped cards in the current window costed from market value. */
  estimated_cards: number;
  franchises: PackTree<CogsFigures>;
};

function cogsFigures(
  slug: string,
  w: CogsWindowRows,
  costOf: CostOf,
  rates: readonly DayRate[],
  fallback: number,
): CogsFigures {
  const f: CogsFigures = {
    pulls: 0,
    pulled_sen: 0,
    buyback_sen: w.buyback.get(slug) ?? 0,
    shipped_cards: 0,
    shipped_cost_sen: 0,
    estimated_cards: 0,
    total_sen: 0,
  };
  for (const p of w.pulled) {
    if (p.slug !== slug) continue;
    f.pulls += p.n;
    f.pulled_sen += Math.round(p.usd * rateOn(p.day, rates, fallback) * 100);
  }
  for (const s of w.shipped) {
    if (s.slug !== slug) continue;
    f.shipped_cards += s.n;
    const cost = costOf(s.handle, s.day);
    if (cost !== null) {
      f.shipped_cost_sen += Math.round(cost * 100) * s.n;
    } else {
      f.estimated_cards += s.n;
      f.shipped_cost_sen +=
        Math.round((s.market_usd ?? 0) * rateOn(s.day, rates, fallback) * 100) *
        s.n;
    }
  }
  f.total_sen = f.buyback_sen + f.shipped_cost_sen;
  return f;
}

const cogsActive = (f: CogsFigures | null) =>
  f !== null && (f.pulls !== 0 || f.buyback_sen !== 0 || f.shipped_cards !== 0);

/** Every pack slug a COGS window names. */
export function cogsSlugsOf(...windows: (CogsWindowRows | null)[]): string[] {
  const s = new Set<string>();
  for (const w of windows) {
    if (!w) continue;
    for (const k of w.buyback.keys()) s.add(k);
    for (const p of w.pulled) s.add(p.slug);
    for (const p of w.shipped) s.add(p.slug);
  }
  return [...s];
}

/** COGS by franchise → type → pack: buyback paid + supplier cost of shipped
 *  cards (decision 1). Coin flip and Lucky Draw costs join in their own
 *  sections. `costOf(handle, day)` is the card's weighted-average supplier
 *  cost in RM as of that ship day (costAsOf)
 *  (inventory-cost.ts), null when it has none. */
export function cogsSection(
  meta: readonly PackMeta[],
  current: CogsWindowRows,
  previous: CogsWindowRows | null,
  costOf: CostOf,
  rates: readonly DayRate[],
  fallbackRate: number,
): CogsSection {
  const tree = packTree(
    meta,
    cogsSlugsOf(current, previous),
    !!previous,
    (m) => {
      const cur = cogsFigures(m.slug, current, costOf, rates, fallbackRate);
      const prev = previous
        ? cogsFigures(m.slug, previous, costOf, rates, fallbackRate)
        : null;
      return cogsActive(cur) || cogsActive(prev)
        ? { current: cur, previous: prev }
        : null;
    },
  );
  const packs = tree.franchises.flatMap((f) => f.types.flatMap((t) => t.packs));
  const sum = (pick: (f: CogsFigures) => number, prev: boolean) =>
    packs.reduce(
      (n, p) => n + pick((prev ? p.previous : p.current) ?? p.current),
      0,
    );
  return {
    total: tree.total,
    pulled: {
      current_sen: sum((f) => f.pulled_sen, false),
      previous_sen: previous ? sum((f) => f.pulled_sen, true) : null,
    },
    purchase: {
      current_sen: current.purchase_sen,
      previous_sen: previous ? previous.purchase_sen : null,
    },
    estimated_cards: sum((f) => f.estimated_cards, false),
    franchises: tree.franchises,
  };
}

// ── Shipping (other revenue) and totals (spec §5, §8) ────────────────────────

export type ShippingWindow = {
  shipping_sen: number;
  insurance_sen: number;
  orders: number;
};

export type ShippingSection = {
  shipping: Pair;
  insurance: Pair;
  total: Pair;
  orders: { current: number; previous: number | null };
};

/** Delivery charge and insurance by order creation date, canceled orders out. */
export function shippingSection(
  current: ShippingWindow,
  previous: ShippingWindow | null,
): ShippingSection {
  const pair = (pick: (w: ShippingWindow) => number): Pair => ({
    current_sen: pick(current),
    previous_sen: previous ? pick(previous) : null,
  });
  return {
    shipping: pair((w) => w.shipping_sen),
    insurance: pair((w) => w.insurance_sen),
    total: pair((w) => w.shipping_sen + w.insurance_sen),
    orders: {
      current: current.orders,
      previous: previous ? previous.orders : null,
    },
  };
}

export type TotalsInput = {
  revenue: Record<string, Pair>;
  other_revenue: Record<string, Pair>;
  cogs: Record<string, Pair>;
  marketing: Pair;
};

export type TotalsSection = {
  /** The named lines each total was summed from, for the page. */
  parts: TotalsInput;
  revenue: Pair;
  other_revenue: Pair;
  total_revenue: Pair;
  cogs: Pair;
  gross: Pair;
  marketing: Pair;
  net: Pair;
};

const sumPairs = (pairs: Pair[]): Pair =>
  pairs.reduce<Pair>(
    (a, b) => ({
      current_sen: a.current_sen + b.current_sen,
      previous_sen:
        a.previous_sen === null || b.previous_sen === null
          ? null
          : a.previous_sen + b.previous_sen,
    }),
    { current_sen: 0, previous_sen: 0 },
  );

const minus = (a: Pair, b: Pair): Pair =>
  sumPairs([
    a,
    {
      current_sen: -b.current_sen,
      previous_sen: b.previous_sen === null ? null : -b.previous_sen,
    },
  ]);

/** The owner's bottom line (decision 7: no discount line): revenue + other
 *  revenue = total revenue; total − COGS = gross; gross − marketing = net. */
export function totalsSection(i: TotalsInput): TotalsSection {
  const revenue = sumPairs(Object.values(i.revenue));
  const other_revenue = sumPairs(Object.values(i.other_revenue));
  const total_revenue = sumPairs([revenue, other_revenue]);
  const cogs = sumPairs(Object.values(i.cogs));
  const gross = minus(total_revenue, cogs);
  return {
    parts: i,
    revenue,
    other_revenue,
    total_revenue,
    cogs,
    gross,
    marketing: i.marketing,
    net: minus(gross, i.marketing),
  };
}
