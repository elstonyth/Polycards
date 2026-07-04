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

// Upload one image to the validated POST /admin/media route (type/resolution/
// aspect/size gated server-side; stores the original untouched). Returns the
// served URL to persist on the card/pack. `kind` selects the validation
// profile (pack ≈ square, card ≈ 5:7).
export async function uploadImage(
  file: File,
  kind: 'pack' | 'card' | 'sprite',
): Promise<string> {
  const body = new FormData();
  body.append('files', file);
  body.append('kind', kind);

  const res = await fetch(`${__BACKEND_URL__}/admin/media`, {
    method: 'POST',
    body,
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  const data = (await res.json()) as { url?: string };
  const url = data.url;
  if (!url) {
    throw new Error('Upload returned no file URL.');
  }
  return url;
}

export async function deleteCard(handle: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/cards/${encodeURIComponent(handle)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
}

export async function deletePack(slug: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/packs/${encodeURIComponent(slug)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    credentials: 'include',
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
  /** Gacha facts staged on product.metadata — autofill for the register form. */
  set: string | null;
  grade: string | null;
  grader: string | null;
  fmv: number | null;
  pc_product_id: string | null;
  pc_grade: string | null;
}

export async function listEligibleProducts(): Promise<EligibleProduct[]> {
  const data = await getJson<{ products: EligibleProduct[] }>(
    '/admin/gacha/eligible-products',
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
  status: 'vaulted' | 'bought_back';
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
  vip: { level: number; highest_level_ever: number; spend: number } | null;
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

// ── Customer 360: referral tree + commissions (Phase 4 P4.1) ─────────────────

export interface ReferralTreeNode {
  customer_id: string;
  depth: number;
  sponsor_id: string | null;
  vip_level: number | null;
  lifetime_external_spend_sen: string;
  frozen: boolean;
  direct_recruit_count: number;
  has_more_depth: boolean;
  handle: string | null;
  email: string | null;
  created_at: string | null;
}
export interface ReferralTree {
  root: ReferralTreeNode;
  nodes: ReferralTreeNode[];
  maxDepth: number;
  truncated: boolean;
}
export const getReferralTree = (id: string, maxDepth = 6) =>
  getJson<ReferralTree>(
    `/admin/customers/${encodeURIComponent(id)}/referral-tree?maxDepth=${maxDepth}`,
  );

export interface AdminCommissionRow {
  id: string;
  generation: number;
  kind: 'direct' | 'override';
  status: 'pending' | 'available' | 'suspended' | 'reversed';
  amount: string;
  reason: string;
  matures_at: string;
  reversal_transaction_id: string | null;
  source_transaction_id: string;
  opener: { customer_id: string | null; handle: string | null };
  created_at: string;
}
export const getCustomerCommissions = (id: string, page = 0, limit = 50) =>
  getJson<{ commissions: AdminCommissionRow[] }>(
    `/admin/customers/${encodeURIComponent(id)}/commissions?limit=${limit}&offset=${page * limit}`,
  );

// ── Phase 4 P4.2 — audit timeline ───────────────────────────────────────────

export interface AuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  created_at: string;
  admin_id: string;
}

export interface AccountState {
  frozen: boolean;
  freeze_reason: string | null;
  freeze_cause: string | null;
  frozen_at: string | null;
}

export interface CustomerAudit {
  account_state: AccountState | null;
  actions: AuditRow[];
}

export const getCustomerAudit = (id: string, page = 0, limit = 50) =>
  getJson<CustomerAudit>(
    `/admin/customers/${encodeURIComponent(id)}/audit?limit=${limit}&offset=${page * limit}`,
  );

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as T;
}

export const freezeCustomer = (id: string, reason: string) =>
  postJson<{ frozen: boolean }>(
    `/admin/customers/${encodeURIComponent(id)}/freeze`,
    { reason },
  );

export const unfreezeCustomer = (id: string, reason: string) =>
  postJson<{ frozen: boolean }>(
    `/admin/customers/${encodeURIComponent(id)}/unfreeze`,
    { reason },
  );

export const reverseCommission = (commId: string, reason: string) =>
  postJson<{ reversed: boolean }>(
    `/admin/commissions/${encodeURIComponent(commId)}/reverse`,
    { reason },
  );

export const suspendCommission = (commId: string, reason: string) =>
  postJson<{ suspended: boolean }>(
    `/admin/commissions/${encodeURIComponent(commId)}/suspend`,
    { reason },
  );

export const unsuspendCommission = (commId: string, reason: string) =>
  postJson<{ suspended: boolean }>(
    `/admin/commissions/${encodeURIComponent(commId)}/unsuspend`,
    { reason },
  );

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
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
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
  return getJson<EconomyReport>('/admin/economy');
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
  /** PriceCharting's card photo (their public GCS bucket), when they have one. */
  image: string | null;
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

// Mint a standalone marketplace Product from a PriceCharting lookup (no card
// created here — see docs/research for the product-first flow).
export async function createProductFromPriceCharting(body: {
  pc_product_id: string;
  pc_grade: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  image: string;
  price?: number | null;
  for_sale?: boolean;
  stock?: number;
  pokemon_dex?: number | null;
  sprite_image?: string | null;
}): Promise<{ id: string; handle: string }> {
  const data = await postJson<{ product: { id: string; handle: string } }>(
    '/admin/products/from-pricecharting',
    body,
  );
  return data.product;
}

// ── FX rate (USD -> MYR) ─────────────────────────────────────────────────────

export interface FxRateState {
  effective: number;
  manual_override: boolean;
  manual_rate: number | null;
  fetched_at: string | null;
}

export const getFxRate = () => getJson<FxRateState>('/admin/pricing/fx');

export const setFxRate = (body: {
  manual_override: boolean;
  manual_rate?: number | null;
}) => postJson<{ effective: number }>('/admin/pricing/fx', body);

// ── Delivery orders ──────────────────────────────────────────────────────────

export type DeliveryStatus =
  | 'requested'
  | 'packing'
  | 'shipped'
  | 'delivered'
  | 'canceled';

export interface AdminDeliveryItem {
  pull_id: string;
  card: { handle: string; name: string; image: string } | null;
}
export interface AdminDeliveryOrder {
  id: string;
  customer_id: string;
  customer_email: string | null;
  status: DeliveryStatus;
  address: {
    name: string;
    address_1: string;
    address_2: string | null;
    city: string;
    province: string | null;
    postal_code: string;
    country_code: string;
    phone: string | null;
  };
  tracking_number: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  items: AdminDeliveryItem[];
}

export async function listDeliveryOrders(
  status?: DeliveryStatus,
): Promise<AdminDeliveryOrder[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await getJson<{ orders: AdminDeliveryOrder[] }>(
    `/admin/delivery-orders${qs}`,
  );
  return data.orders;
}

export async function getDeliveryOrder(
  id: string,
): Promise<AdminDeliveryOrder> {
  const data = await getJson<{ order: AdminDeliveryOrder }>(
    `/admin/delivery-orders/${encodeURIComponent(id)}`,
  );
  return data.order;
}

export async function updateDeliveryOrder(
  id: string,
  body: { status?: DeliveryStatus; tracking_number?: string | null },
): Promise<{ order_id: string; status: DeliveryStatus }> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/delivery-orders/${encodeURIComponent(id)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as { order_id: string; status: DeliveryStatus };
}

// ── Daily Rewards (level-range vouchers + VIP-tier boxes) ───────────────────

export interface DailyBoxSummary {
  tier: string;
  name: string;
  enabled: boolean;
  draws_per_day: number;
  prize_count: number;
  customer_count: number;
  level_from: number;
  level_to: number;
}

export interface DailyBoxPrizeDTO {
  id?: string;
  kind: 'credit' | 'product' | 'voucher' | 'nothing';
  payload: Record<string, unknown>;
  locked: boolean;
  pct: number;
}

export interface DailyBoxEditorDTO {
  box: { tier: string; name: string; enabled: boolean; draws_per_day: number };
  prizes: DailyBoxPrizeDTO[];
}

export interface DailyBoxSaveBody {
  name: string;
  enabled: boolean;
  draws_per_day: number;
  reason: string;
  prizes: {
    kind: 'credit' | 'product' | 'voucher' | 'nothing';
    locked: boolean;
    pct: number;
    amount_myr?: number;
    product_handle?: string;
    qty?: number;
  }[];
}

export interface VoucherRangeDTO {
  from: number;
  to: number;
  amount_myr: number;
}

export interface VoucherLadderDTO {
  levels: { level: number; amount_myr: number }[];
  ranges: VoucherRangeDTO[];
}

// GET the VIP-tier daily boxes list (summary row per tier).
export async function getDailyBoxes(): Promise<{ boxes: DailyBoxSummary[] }> {
  return getJson<{ boxes: DailyBoxSummary[] }>('/admin/daily-rewards/boxes');
}

// GET one tier's box config + prize table. 404s for an unknown tier.
export async function getDailyBox(tier: string): Promise<DailyBoxEditorDTO> {
  return getJson<DailyBoxEditorDTO>(
    `/admin/daily-rewards/boxes/${encodeURIComponent(tier)}`,
  );
}

// Replace-all a tier's box + prizes. Throws Error(message) on a 400 validation
// failure (errorMessage surfaces the backend MedusaError message).
export async function saveDailyBox(
  tier: string,
  body: DailyBoxSaveBody,
): Promise<DailyBoxEditorDTO> {
  return postJson<DailyBoxEditorDTO>(
    `/admin/daily-rewards/boxes/${encodeURIComponent(tier)}`,
    body,
  );
}

// GET the level-range voucher ladder (100 per-level amounts + authored ranges).
export async function getVoucherLadder(): Promise<VoucherLadderDTO> {
  return getJson<VoucherLadderDTO>('/admin/daily-rewards/vouchers');
}

// Replace-all the voucher ranges. Audited edit; `reason` is mandatory.
export async function saveVoucherRanges(body: {
  ranges: VoucherRangeDTO[];
  reason: string;
}): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/admin/daily-rewards/vouchers', body);
}
