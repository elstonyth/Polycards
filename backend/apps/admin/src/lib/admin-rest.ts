// Direct-fetch helpers for the custom admin endpoints the @mercurjs/client
// path-proxy doesn't cover: multipart upload and DELETE. Both rely on the same
// cookie session as `client` (credentials: 'include' → the auto-protected
// /admin/* routes). __BACKEND_URL__ is injected by the dashboard Vite plugin.

declare const __BACKEND_URL__: string;

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return (data && data.message) || `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

// Upload one image to Medusa's native file route; returns the served URL
// (e.g. http://localhost:9000/static/<file>) to store on the card/pack.
export async function uploadImage(file: File): Promise<string> {
  const body = new FormData();
  body.append("files", file);

  const res = await fetch(`${__BACKEND_URL__}/admin/uploads`, {
    method: "POST",
    body,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  const data = (await res.json()) as { files?: { url?: string }[] };
  const url = data.files?.[0]?.url;
  if (!url) {
    throw new Error("Upload returned no file URL.");
  }
  return url;
}

export async function deleteCard(handle: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/cards/${encodeURIComponent(handle)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
}

export async function deletePack(slug: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/packs/${encodeURIComponent(slug)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as T;
}

// Inventory products that can still be registered as gacha cards (no card with
// their handle yet). The "Add card" picker is driven by this list.
export interface EligibleProduct {
  id: string;
  title: string;
  handle: string;
  thumbnail: string | null;
  status: string;
}

export async function listEligibleProducts(): Promise<EligibleProduct[]> {
  const data = await getJson<{ products: EligibleProduct[] }>(
    "/admin/gacha/eligible-products",
  );
  return data.products;
}

// ── Customer support view ────────────────────────────────────────────────────

export interface SupportCustomer {
  id: string;
  email: string;
  first_name: string | null;
  created_at: string;
}

export interface SupportTransaction {
  id: string;
  amount: number;
  reason: string;
  reference: string | null;
  created_at: string;
}

export interface SupportPull {
  id: string;
  pack_id: string;
  rolled_at: string;
  status: "vaulted" | "bought_back";
  buyback_amount: number | null;
  card: {
    handle: string;
    name: string;
    market_value: number;
    image: string;
  } | null;
}

export interface CustomerGacha {
  customer: SupportCustomer;
  balance: number;
  transactions: SupportTransaction[];
  pulls: SupportPull[];
  vault: { count: number; market_value: number };
}

// Core Medusa admin customer search (?q matches email/name).
export async function searchCustomers(q: string): Promise<SupportCustomer[]> {
  const data = await getJson<{ customers: SupportCustomer[] }>(
    `/admin/customers?q=${encodeURIComponent(q)}&limit=10`,
  );
  return data.customers;
}

export async function getCustomerGacha(id: string): Promise<CustomerGacha> {
  return getJson<CustomerGacha>(
    `/admin/customers/${encodeURIComponent(id)}/gacha`,
  );
}

// Operator credit adjustment: signed amount, required audit note. The backend
// enforces the $0 balance floor and returns the fresh balance.
export async function adjustCustomerCredits(
  id: string,
  amount: number,
  note: string,
): Promise<{ amount: number; balance: number }> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/customers/${encodeURIComponent(id)}/credits`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, note }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as { amount: number; balance: number };
}

// ── Economy report ───────────────────────────────────────────────────────────

export interface EconomyReport {
  totals: {
    revenue: number;
    payouts: number;
    topups: number;
    adjustments: number;
    net: number;
  };
  liability: { count: number; market_value: number };
  packs: {
    slug: string;
    title: string;
    category: string;
    price: number;
    /** Odds-weighted expected FMV per open; null when unanswerable. */
    ev: number | null;
    /** ev / price × 100; > 100 means the pack loses money. */
    rtp_pct: number | null;
  }[];
}

export async function getEconomyReport(): Promise<EconomyReport> {
  return getJson<EconomyReport>("/admin/economy");
}

// PriceCharting proxies (the API token lives server-side only). A 503 from the
// proxy means PRICECHARTING_API_TOKEN is not configured — surface the message
// and fall back to manual FMV entry.
export interface PcMatch {
  id: string;
  name: string;
  set: string;
}

export interface PcProduct {
  id: string;
  name: string;
  set: string;
  /** Per-grade values in USD, ascending grade order; absent grades omitted. */
  prices: { grade: string; usd: number }[];
}

export async function searchPriceCharting(q: string): Promise<PcMatch[]> {
  const data = await getJson<{ matches: PcMatch[] }>(
    `/admin/pricecharting/search?q=${encodeURIComponent(q)}`,
  );
  return data.matches;
}

export async function getPriceChartingProduct(id: string): Promise<PcProduct> {
  const data = await getJson<{ product: PcProduct }>(
    `/admin/pricecharting/product?id=${encodeURIComponent(id)}`,
  );
  return data.product;
}
