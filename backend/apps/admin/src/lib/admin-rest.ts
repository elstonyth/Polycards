// Direct-fetch helpers for the custom admin endpoints the @mercurjs/client
// path-proxy doesn't cover: multipart upload and DELETE. Both rely on the same
// cookie session as `client` (credentials: 'include' → the auto-protected
// /admin/* routes). __BACKEND_URL__ is injected by the dashboard Vite plugin.

import type { PullsResponse } from './packs-api';

declare const __BACKEND_URL__: string;

// Every failing call in this file rejects through here, so the HTTP status is
// carried on the Error everywhere rather than only on the one route that needed
// it. Without it a page can only match on `message`, and an unrouted Medusa 404
// carries NO message field at all — so "not found" and "the backend restarted"
// are indistinguishable, and the operator reads a 500 as a deleted record.
async function httpError(res: Response): Promise<Error> {
  let message: string;
  try {
    const data = await res.json();
    message = (data && data.message) || `Request failed (${res.status}).`;
  } catch {
    message = `Request failed (${res.status}).`;
  }
  return Object.assign(new Error(message), { status: res.status });
}

/** The HTTP status a rejected admin-rest call failed with, or undefined when
 *  the request never got a response (offline, DNS, CORS) — in which case the
 *  failure is emphatically NOT a 404 and must not be reported as one. */
export const httpStatus = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
};

// Upload one image to the validated POST /admin/media route (type/resolution/
// aspect/size gated server-side; stores the original untouched). Returns the
// served URL to persist on the card/pack. `kind` selects the validation
// profile (pack ≈ square, card ≈ 5:7).
export async function uploadImage(
  file: File,
  kind: 'pack' | 'display' | 'card' | 'sprite' | 'frame' | 'avatar-frame' | 'delivery',
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
    throw await httpError(res);
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
    throw await httpError(res);
  }
}

export async function deletePack(slug: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/packs/${encodeURIComponent(slug)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw await httpError(res);
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

// ── Pull ledger ───────────────────────────────────────────────────────────────

// `customerId` scopes the ledger to one player. Blank values are OMITTED — the
// route 400s on an empty customer_id rather than falling back to every player.
export const getPulls = (
  page = 0,
  limit = 50,
  source?: 'pack' | 'reward',
  customerId?: string,
) =>
  getJson<PullsResponse>(
    `/admin/pulls?limit=${limit}&offset=${page * limit}${source ? `&source=${source}` : ''}${
      customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''
    }`,
  );

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
  /** When the sell-back was paid (bought_back only). Optional: the /gacha
   *  fallback rows don't carry the dispute fields — only /pulls does. */
  buyback_at?: string | null;
  /** Payable-now sell quote on a vaulted card pull — same helpers as the
   *  customer's vault, so this number matches their sell button exactly.
   *  firm:false = priced on the FX display fallback (sells are refused). */
  quote?: {
    percent: number;
    amount: number;
    rate_type: string;
    firm: boolean;
    instant_deadline_ms: number;
  } | null;
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
  /** market_value = raw FMV owed; display_value = FMV × the card's own markup,
   *  i.e. the number the storefront shows the player. */
  vault: { count: number; market_value: number; display_value: number };
  vip: {
    level: number;
    highest_level_ever: number;
    spend: number;
    /** null at the top of the ladder. */
    next: { level: number; threshold: number; remaining: number } | null;
  } | null;
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

export const getCustomerTransactions = (id: string, page = 0, limit = 25) =>
  getJson<{ items: SupportTransaction[]; total: number }>(
    `/admin/customers/${encodeURIComponent(id)}/transactions?limit=${limit}&offset=${page * limit}`,
  );

// `opts` narrows the history server-side (status = vaulted | bought_back |
// delivering | delivered, source = pack | reward). Blank values are OMITTED so
// every filter param follows one rule (see getPulls).
export const getCustomerPulls = (
  id: string,
  page = 0,
  limit = 25,
  opts?: { status?: string; source?: string },
) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (opts?.status) params.set('status', opts.status);
  if (opts?.source) params.set('source', opts.source);
  return getJson<{
    items: SupportPull[];
    total: number;
    /** firm:false = the backend is on its FX display fallback — every
     *  customer sell is being refused while quotes still show amounts. */
    fx?: { rate: number; firm: boolean };
  }>(`/admin/customers/${encodeURIComponent(id)}/pulls?${params}`);
};

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

// frozen (funds) and disabled (login) are orthogonal — one can be set without
// the other, and each carries its own reason/actor/timestamp.
export interface AccountState {
  frozen: boolean;
  freeze_reason: string | null;
  freeze_cause: string | null;
  frozen_at: string | null;
  disabled: boolean;
  disabled_reason: string | null;
  disabled_by: string | null;
  disabled_at: string | null;
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
    throw await httpError(res);
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
    throw await httpError(res);
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

// Optional [from, to) ISO window scopes the ledger totals to a period; omit
// both for all-time (the default). Liability + RTP are always current-state.
export async function getEconomyReport(
  from?: string,
  to?: string,
): Promise<EconomyReport> {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const q = qs.toString();
  return getJson<EconomyReport>(`/admin/economy${q ? `?${q}` : ''}`);
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

// §7a label prefill: year (set release) + note (rarity) from pokemontcg.io,
// proxied server-side. Always resolves — a lookup miss/outage returns nulls,
// never throws (see api/admin/tcg/tcg-meta.ts).
export interface TcgCardMeta {
  year: string | null;
  note: string | null;
}

export const getTcgCardMeta = (set: string, number: string) =>
  getJson<TcgCardMeta>(
    `/admin/tcg/card-meta?set=${encodeURIComponent(set)}&number=${encodeURIComponent(number)}`,
  );

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
  /** PixelPokemon library id (Spec 2 §5) staged on the product's metadata.
   *  Required — the backend rejects creation without it (no name-derivation
   *  fallback for from-PC products). */
  pixel_pokemon_id: string;
  /** Slab-label text (§8), staged onto product.metadata; null = blank. */
  label_year?: string | null;
  label_note?: string | null;
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
  reason: string;
}) => postJson<{ effective: number }>('/admin/pricing/fx', body);

export interface FxChange {
  at: string;
  admin_id: string;
  before: { manual_override: boolean; manual_rate: number | null } | null;
  after: { manual_override: boolean; manual_rate: number | null };
  reason: string | null;
}

export const getFxHistory = () =>
  getJson<{ changes: FxChange[] }>('/admin/pricing/fx/history');

// ── Delivery orders ──────────────────────────────────────────────────────────

export type DeliveryStatus =
  | 'requested'
  | 'processed'
  | 'ready_to_ship'
  | 'shipped'
  | 'completed'
  | 'canceled';

export interface AdminDeliveryItem {
  pull_id: string;
  card: {
    handle: string;
    name: string;
    image: string;
    slab_image: string | null;
  } | null;
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
  proof_images: string[];
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  items: AdminDeliveryItem[];
}

export interface DeliveryOrdersPage {
  orders: AdminDeliveryOrder[];
  total: number;
  offset: number;
  limit: number;
}

export async function listDeliveryOrders(
  status?: DeliveryStatus,
  page = 0,
  q?: string,
  limit = 50,
  customerId?: string,
): Promise<DeliveryOrdersPage> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (status) params.set('status', status);
  // Id-substring search; ANDs with ?status= server-side. The backend rejects
  // anything over 64 chars, so don't send a longer one.
  if (q) params.set('q', q.slice(0, 64));
  // Scopes the table to one player. Blank is OMITTED, never sent empty.
  if (customerId) params.set('customer_id', customerId);
  return getJson<DeliveryOrdersPage>(`/admin/delivery-orders?${params}`);
}

// Mark up to 100 orders with one status. Partial success is the contract:
// `skipped` carries the refusal (or the benign `already <status>`) per id.
export const bulkUpdateDeliveryOrders = (
  ids: string[],
  status: DeliveryStatus,
) =>
  postJson<{ updated: string[]; skipped: { id: string; reason: string }[] }>(
    '/admin/delivery-orders/bulk',
    { ids, status },
  );

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
  body: {
    status?: DeliveryStatus;
    tracking_number?: string | null;
    proof_images?: string[];
  },
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
    throw await httpError(res);
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
  /** Server-side ceiling for a credit/voucher prize's RM amount — served here
   *  (not hardcoded client-side) so the row validation always matches the
   *  backend's actual limit. */
  max_box_credit_myr: number;
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
// failure (httpError surfaces the backend MedusaError message).
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

// ── Rewards engine settings ──────────────────────────────────────────────────

export interface RewardsSettingsView {
  commissionCooldownDays: number;
  teamOverridePct: number;
  overrideGenerationCap: number;
  withdrawals_per_day: number;
}

export const getRewardsSettings = () =>
  getJson<RewardsSettingsView>('/admin/rewards-settings');

export const saveRewardsSettings = (
  body: Partial<RewardsSettingsView> & { reason: string },
) => postJson<RewardsSettingsView>('/admin/rewards-settings', body);

// ── Site settings (storefront presentation) ─────────────────────────────────

// Slab-frame overlay the storefront layers over every card photo. null URL =
// the storefront's bundled default frame.
export interface SiteSettingsView {
  slab_frame_url: string | null;
}

export const getSiteSettings = () =>
  getJson<SiteSettingsView>('/admin/site-settings');

export const saveSiteSettings = (body: SiteSettingsView & { reason: string }) =>
  postJson<SiteSettingsView>('/admin/site-settings', body);

// ── Avatar frames (VIP-level unlock catalog) ────────────────────────────────

export interface AvatarFramesView {
  frames: Record<string, string>;
}

export const getAvatarFrames = () =>
  getJson<AvatarFramesView>('/admin/avatar-frames');

export const saveAvatarFrames = (body: {
  frames: Record<string, string>;
  reason: string;
}) => postJson<AvatarFramesView>('/admin/avatar-frames', body);

// ── VIP levels (ladder CRUD) ─────────────────────────────────────────────────

export interface VipLevelDTO {
  level: number;
  spend_threshold: number; // MYR
  voucher_amount: number; // MYR
  box_tier: string;
  frame_unlock: boolean;
  direct_referral_pct: number;
}

export const getVipLevels = () =>
  getJson<{ levels: VipLevelDTO[] }>('/admin/vip-levels');

// Replace-all the ladder. Audited edit; `reason` mandatory. Throws
// Error(message) on a 400 (httpError surfaces the backend MedusaError).
export const saveVipLevels = (body: { levels: VipLevelDTO[]; reason: string }) =>
  postJson<{ levels: VipLevelDTO[] }>('/admin/vip-levels', body);

// ── Weekly Challenge (milestone stages + week/payout settings) ───────────────

/** One rank's prize inside a stage. Mirrors ChallengeRankReward in
 *  backend/packages/api/src/modules/packs/challenge-validate.ts. A rank may
 *  carry a card AND/OR credits; ranks absent from the array pay nothing. */
export interface ChallengeRankRewardDTO {
  rank: number; // 1..10
  card_id: string | null;
  credits: number; // MYR credited as store credits
}

export interface ChallengeStageDTO {
  stage_number: number;
  threshold_myr: number; // MYR
  /** SPARSE per-rank prize table, ranks 1..10, ascending. */
  rank_rewards: ChallengeRankRewardDTO[];
}

export const getChallengeStages = () =>
  getJson<{ stages: ChallengeStageDTO[] }>('/admin/challenge/stages');

export const saveChallengeStages = (body: {
  stages: ChallengeStageDTO[];
  reason: string;
}) => postJson<{ stages: ChallengeStageDTO[] }>('/admin/challenge/stages', body);

export interface ChallengeSettingsDTO {
  cadence: string;
  timezone: string;
  reset_day: number;
  reset_hour: number;
}

export const getChallengeSettings = () =>
  getJson<ChallengeSettingsDTO>('/admin/challenge/settings');

// Singleton patch: send only the changed fields under `patch`.
export const saveChallengeSettings = (body: {
  patch: Partial<ChallengeSettingsDTO>;
  reason: string;
}) => postJson<ChallengeSettingsDTO>('/admin/challenge/settings', body);

// ── Pixel-Pokémon library (Pokédex) ──────────────────────────────────────────

export interface PixelPokemonRow {
  id: string;
  name: string;
  dex: number | null;
  variant: string;
  types: string[];
  image_url: string | null;
  is_custom: boolean;
}

export interface PixelPokemonPage {
  pixel_pokemon: PixelPokemonRow[];
  total: number;
  limit: number;
  offset: number;
  /** Distinct types across the whole library, for the filter chips. */
  all_types: string[];
}

export interface PixelPokemonQuery {
  q?: string;
  type?: string;
  variant?: string;
  custom?: '' | 'true' | 'false';
  page?: number;
  limit?: number;
}

// GET the Pokédex library page (filter + paginate server-side).
export async function getPixelPokemon(
  params: PixelPokemonQuery,
): Promise<PixelPokemonPage> {
  const limit = params.limit ?? 60;
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String((params.page ?? 0) * limit),
  });
  if (params.q) qs.set('q', params.q);
  if (params.type) qs.set('type', params.type);
  if (params.variant) qs.set('variant', params.variant);
  if (params.custom) qs.set('custom', params.custom);
  return getJson<PixelPokemonPage>(`/admin/pixel-pokemon?${qs}`);
}

export interface CreatePixelPokemonBody {
  name: string;
  dex?: number | null;
  variant?: string;
  types?: string[];
  image_url: string;
}

// Add a custom pixel-pokémon (sprite already uploaded via uploadImage → url).
export const createPixelPokemon = (body: CreatePixelPokemonBody) =>
  postJson<{ pixel_pokemon: PixelPokemonRow }>('/admin/pixel-pokemon', body);

// ── Epic 2 (Players) ─────────────────────────────────────────────────────────

/** One row of GET /admin/players. All money fields are MYR (the route divides
 *  the stored cents). Dates serialize as ISO strings over JSON. */
export interface PlayerRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  /** Customer-group names — the odds-set membership the operator sees. */
  groups: string[];
  vip_level: number;
  wallet_balance: number;
  vault_value: number;
  vault_count: number;
  total_spend: number;
  total_pulls: number;
  registered_at: string;
  last_spend_at: string | null;
  /** Funds hold. Orthogonal to `disabled` (login block). */
  frozen: boolean;
  disabled: boolean;
}

export interface PlayersPage {
  total: number;
  offset: number;
  limit: number;
  players: PlayerRow[];
}

export const listPlayers = (page = 0, q?: string, limit = 50) =>
  getJson<PlayersPage>(
    `/admin/players?limit=${limit}&offset=${page * limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );

// Login block / unblock. `reason` is mandatory (1–500 chars) and audited; the
// admin actor is taken from the session server-side, never sent from here.
export const disablePlayer = (id: string, reason: string) =>
  postJson<{ disabled: boolean }>(
    `/admin/customers/${encodeURIComponent(id)}/disable`,
    { reason },
  );

export const enablePlayer = (id: string, reason: string) =>
  postJson<{ disabled: boolean }>(
    `/admin/customers/${encodeURIComponent(id)}/enable`,
    { reason },
  );

/** Manual-cashout bank destination. Admin-only — never exposed on /store. */
export interface PayoutDetails {
  bank_name: string;
  bank_account_number: string;
  account_holder_name: string | null;
}

export const getPayoutDetails = (id: string) =>
  getJson<{ details: PayoutDetails | null }>(
    `/admin/customers/${encodeURIComponent(id)}/payout-details`,
  );

export const savePayoutDetails = (id: string, details: PayoutDetails) =>
  postJson<{ details: PayoutDetails }>(
    `/admin/customers/${encodeURIComponent(id)}/payout-details`,
    details,
  );

// Pack spend per calendar month (MYR), newest first, at most 24 months.
// `period` is a YYYY-MM bucket in Asia/Kuala_Lumpur; empty months are omitted.
export const getSpendReport = (id: string) =>
  getJson<{ periods: { period: string; spend: number }[] }>(
    `/admin/customers/${encodeURIComponent(id)}/spend-report`,
  );

/** Core Medusa customer record (the Profile tab), not the gacha projection. */
export interface AdminCustomerDetail {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export const getCustomerDetail = (id: string) =>
  getJson<{ customer: AdminCustomerDetail }>(
    `/admin/customers/${encodeURIComponent(id)}`,
  );

// ── Epic 3 (Odds) ────────────────────────────────────────────────────────────

// Medusa's NATIVE admin customer-groups API (no repo-side route). The prebuilt
// @mercurjs/admin bundle owns create/edit/membership at /customer-groups; this
// app only reads the list and writes `metadata.odds_set` (1|2|3), which the
// draw path resolves per customer (see packs/odds-sets.ts `coerceOddsSet` —
// anything that is not 2 or 3, including no metadata at all, is set 1).
export interface AdminCustomerGroup {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

// ponytail: limit=100, no pager — `count` reports the true total, so a shop
// that ever grows past 100 groups will see it in the response before anyone
// needs the pagination.
export const listCustomerGroupsAdmin = () =>
  getJson<{ customer_groups: AdminCustomerGroup[]; count: number }>(
    '/admin/customer-groups?limit=100&fields=id,name,metadata',
  );

// Medusa MERGES metadata per key on update (verified live against the native
// route: a sibling key survives this call), so posting only `odds_set` leaves
// the rest of the group's metadata untouched — no read-modify-write needed.
export const setGroupOddsSet = (id: string, set: 1 | 2 | 3) =>
  postJson<{ customer_group: AdminCustomerGroup }>(
    `/admin/customer-groups/${encodeURIComponent(id)}`,
    { metadata: { odds_set: set } },
  );

// ── Epic 5 (Inventory) ───────────────────────────────────────────────────────

/** One line of GET /admin/purchase-invoices/:id. All money is MYR (2dp) — the
 *  purchase path never touches FX. `qty` is SIGNED: negative on a reversing
 *  invoice, and the sign lives ONLY there (unit_cost / fmv_snapshot stay
 *  positive so a reversal line reads the same as the line it undoes).
 *
 *  The detail route spreads the ORM row, so each line ALSO carries the
 *  `raw_unit_cost` / `raw_line_total` / `raw_fmv_snapshot` bigNumber jsonb
 *  sidecars and an always-null `deleted_at`. Bind the hydrated getters below,
 *  never `raw_*`; the sidecars are deliberately left unprojected (admin-only
 *  route) and are not modelled here. */
export interface AdminPurchaseInvoiceLine {
  id: string;
  card_handle: string;
  card_name: string;
  fmv_snapshot: number;
  qty: number;
  unit_cost: number;
  line_total: number;
}

/** One row of GET /admin/purchase-invoices. The three totals are folded
 *  SERVER-side in integer sen (route.ts) — render them, never re-derive them
 *  here: the list response carries no lines to re-derive from. */
export interface AdminPurchaseInvoice {
  id: string;
  display_no: string;
  /** Operator-entered invoice date. `model.dateTime()`, so a full ISO stamp. */
  date: string;
  supplier: string;
  agent_user_id: string;
  /** Joined from the user module; null if the admin account was removed. */
  agent_email: string | null;
  reverses_invoice_id: string | null;
  created_at: string;
  total_qty: number;
  subtotal: number;
  total_fmv: number;
}

// agent_email is NOT omitted: GET /:id joins the user module the same way the
// list route does, so both pages name the same person for one invoice.
export interface AdminPurchaseInvoiceDetail
  extends Omit<AdminPurchaseInvoice, 'total_qty' | 'subtotal' | 'total_fmv'> {
  lines: AdminPurchaseInvoiceLine[];
}

export interface PurchaseInvoicesPage {
  total: number;
  offset: number;
  limit: number;
  invoices: AdminPurchaseInvoice[];
}

// `sort` is `<column>:<asc|desc>`; the route allowlists the column and falls
// back to created_at, so an unknown key can never 400. `q` matches supplier OR
// display_no and is TRUNCATED to 100 chars server-side — the search input
// carries a matching maxLength so the operator cannot type past the cut.
export const listPurchaseInvoices = (
  page = 0,
  q?: string,
  limit = 50,
  sort = 'created_at:desc',
) =>
  getJson<PurchaseInvoicesPage>(
    `/admin/purchase-invoices?limit=${limit}&offset=${page * limit}&sort=${encodeURIComponent(sort)}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );

export const getPurchaseInvoice = (id: string) =>
  getJson<{ invoice: AdminPurchaseInvoiceDetail }>(
    `/admin/purchase-invoices/${encodeURIComponent(id)}`,
  );

export interface CreatePurchaseInvoiceLineBody {
  card_handle: string;
  card_name: string;
  fmv_snapshot: number;
  qty: number;
  unit_cost: number;
}

export interface CreatePurchaseInvoiceBody {
  date: string;
  supplier: string;
  reverses_invoice_id?: string | null;
  lines: CreatePurchaseInvoiceLineBody[];
}

// agent_user_id is NOT sent — the route derives it from the session.
export const createPurchaseInvoice = (body: CreatePurchaseInvoiceBody) =>
  postJson<{ invoice: AdminPurchaseInvoiceDetail }>(
    '/admin/purchase-invoices',
    body,
  );

/** One row of GET /admin/inventory (spec §3.3).
 *
 *  The grain is PRODUCTS, not registered gacha cards: a catalog product with no
 *  Card row still gets a row — that is exactly what the "List to gacha card"
 *  bulk tool acts on, and `is_card` tells the two apart.
 *
 *  `cost` and `on_hand` are THREE-STATE and the distinction is load-bearing:
 *  `null` = no purchase history / tracks no inventory at all; `0` = bought and
 *  free / tracked with nothing shippable. The route builds both with `??` and
 *  never `||` (inventory-view.ts says so in as many words, and
 *  inventory-detail.spec pins all four states) — so nothing on this side may
 *  collapse them with a truthiness test either. `fmv`/`price` are null when the
 *  product carries no FMV at all, never NaN and never 0-by-accident.
 *
 *  All money is MYR and arrives as plain JS numbers (the route folds through
 *  displayMarketPrice / weightedAverageCost, not through a bigNumber getter),
 *  so it feeds rm() unwrapped — see the Number() note on
 *  AdminPurchaseInvoiceLine for the case where that is NOT true. */
export interface InventoryRow {
  handle: string;
  product_id: string;
  photo: string | null;
  name: string;
  sku: string;
  is_card: boolean;
  /** RAW vs GRADED, derived from the card's (or the product metadata's) grader. */
  graded: boolean;
  fmv: number | null;
  price: number | null;
  cost: number | null;
  created_at: string;
  on_hand: number | null;
  in_vault: number;
  requested: number;
  shipped: number;
  listing_count: number;
}

// UNPAGED by design (the route says why): on_hand/cost/buckets are all computed
// after the product read, so ordering can only happen client-side.
//
// `q` is Medusa's own free-text search — title/subtitle/description plus the
// variants' title/sku/barcode — and it is NOT wildcard-escaped, so this stays a
// plain search box and never a pattern field. The route truncates it at 100
// chars; the page's input carries a matching maxLength so the operator cannot
// type past the cut.
export const listInventory = (q?: string) =>
  getJson<{ rows: InventoryRow[] }>(
    `/admin/inventory${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  );

/** One row of the append-only stock-movement audit log (spec §3.1).
 *
 *  `kind` is typed as a plain string, not the seven-member enum: the model
 *  defines all seven but this epic only ever WRITES 'purchase', so the display
 *  side resolves the label with a raw-token fallback rather than pretending a
 *  map is exhaustive — same rule deliveryStatusLabel documents.
 *
 *  `qty` is SIGNED and is a `model.number()`, NOT a bigNumber — so unlike
 *  AdminPurchaseInvoiceLine it needs no Number() wrap and there are no raw_*
 *  sidecars on the wire. */
export interface InventoryStockMovement {
  id: string;
  card_handle: string;
  kind: string;
  qty: number;
  ref_id: string;
  created_at: string;
}

/** GET /admin/inventory/:handle (spec §3.4) — the same row the list renders,
 *  plus where the card is listed and its paged movement history. `item` is a
 *  whole InventoryRow, so the same three-state `cost` / `on_hand` rules apply
 *  here verbatim: null and 0 are different facts, and nothing may collapse
 *  them with a truthiness test. */
export interface InventoryDetail {
  item: InventoryRow;
  associated: {
    packs: { slug: string; title: string }[];
    rank_rewards: { stage_number: number; rank: number }[];
  };
  movements: {
    total: number;
    offset: number;
    limit: number;
    rows: InventoryStockMovement[];
  };
}

// Only the MOVEMENTS are paged — `item` and `associated` are re-sent whole with
// every page, so the page state belongs to the history table alone. The route
// caps limit at 100 and defaults to 25.
export const getInventoryItem = (handle: string, page = 0, limit = 25) =>
  getJson<InventoryDetail>(
    `/admin/inventory/${encodeURIComponent(handle)}?limit=${limit}&offset=${page * limit}`,
  );

// GET /admin/inventory/export.xlsx -- the same rows GET /admin/inventory
// returns, as a workbook, with the CURRENT FILTER applied (spec section 3.3).
//
// A raw fetch rather than getJson for the same reason uploadImage is one: the
// response is a binary .xlsx, so parsing it as JSON would throw on a perfectly
// good download. Errors still route through httpError, so a failed export
// carries its HTTP status like every other call in this file.
//
// `q` is passed through unchanged -- the route truncates at 100 chars exactly
// as the list route does, so the sheet's rows are the visible list's rows.
export async function exportInventoryXlsx(q?: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/inventory/export.xlsx${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Wins over the response's Content-Disposition, and must: the blob URL is
  // same-origin to this page, so the backend's filename never reaches the
  // browser here. Same YYYY-MM-DD shape either way.
  a.download = `inventory-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // DEFERRED, not revoked on the next line: click() only SCHEDULES the
  // download, and revoking the object URL in the same task can leave the
  // browser fetching a URL that no longer resolves -- an empty or cancelled
  // file. Handing the revoke to the next task lets the download claim the blob
  // first, while still releasing it (a leaked object URL lives until reload).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
