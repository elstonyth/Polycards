// Direct-fetch helpers for the custom admin endpoints the @mercurjs/client
// path-proxy doesn't cover: multipart upload and DELETE. Both rely on the same
// cookie session as `client` (credentials: 'include' → the auto-protected
// /admin/* routes). __BACKEND_URL__ is injected by the dashboard Vite plugin.

import type { PullsResponse } from './packs-api';
import type { GroupPolicy } from './player-groups';

declare const __BACKEND_URL__: string;

// Every failing call in this file rejects through here, so the HTTP status is
// carried on the Error everywhere rather than only on the one route that needed
// it. Without it a page can only match on `message`, and an unrouted Medusa 404
// carries NO message field at all — so "not found" and "the backend restarted"
// are indistinguishable, and the operator reads a 500 as a deleted record.
async function httpError(res: Response): Promise<Error> {
  let message: string;
  let data: unknown;
  try {
    data = await res.json();
    const text = (data as { message?: unknown } | null)?.message;
    message =
      typeof text === 'string' && text
        ? text
        : `Request failed (${res.status}).`;
  } catch {
    message = `Request failed (${res.status}).`;
  }
  // `data` rides along for routes whose refusal carries more than a message
  // (the gateway switch's live-check problems and its can_force flag).
  return Object.assign(new Error(message), { status: res.status, data });
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
// profile (pack ≈ 5:9 portrait, card ≈ 5:7).
export async function uploadImage(
  file: File,
  kind:
    | 'pack'
    | 'display'
    | 'card'
    | 'sprite'
    | 'frame'
    | 'avatar-frame'
    | 'delivery'
    | 'announcement',
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

export interface PricingIssue {
  handle: string;
  name: string;
  pc_product_id: string | null;
  pc_grade: string | null;
  market_value: number;
  last_synced_at: string | null;
  reason:
    | 'pending_confirmation'
    | 'sync_error'
    | 'never_synced'
    | 'stale'
    | 'unlinked'
    | 'missing_product';
  proposed_value: number | null;
  first_seen_at: string | null;
  message: string | null;
}

export interface PricingHealth {
  fx: {
    rate: number;
    source: string;
    manual_override: boolean;
    fetched_at: string | null;
    age_hours: number | null;
  } | null;
  cards: {
    linked: number;
    never_synced: number;
    stale_48h: number;
    missing_product: string[];
    pending_confirmation: number;
    unlinked: number;
    issues: PricingIssue[];
  };
}

export const getPricingHealth = (): Promise<PricingHealth> =>
  getJson('/admin/pricing/health');

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
  /** The row's spend-only bonus part, signed like it (RM). /transactions
   *  only; absent on the /gacha slice. */
  bonus?: number;
  reason: string;
  reference: string | null;
  created_at: string;
  /** Ledger display id (TP…, SP…) where one exists. /transactions only. */
  ledger_display_id?: string | null;
  /** The wallet balance right after this row. /transactions only. */
  balance_after?: number | null;
  /** What the row was about (/transactions only): the pack and cards behind a
   *  pack open or sell-back, the shipment behind a shipping fee. */
  pack_title?: string | null;
  cards?: { pull_id: string; name: string; image: string | null }[];
  order_id?: string | null;
}

export interface SupportPull {
  id: string;
  pack_id: string;
  /** The pack's title (/pulls only). */
  pack_title?: string | null;
  rolled_at: string;
  status: 'vaulted' | 'bought_back' | 'delivering' | 'delivered';
  /** How they got it: pack | reward | free | gift | bonus (/pulls only). */
  source?: string | null;
  /** The live shipment of a delivering or delivered card (/pulls only). */
  order_id?: string | null;
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
    /** Per-pack tier of the pull (/pulls only). */
    rarity?: string | null;
    market_value: number;
    image: string;
  } | null;
}

export interface CustomerGacha {
  customer: SupportCustomer;
  balance: number;
  /** Spend-only bonus credit (MYR) inside `balance` — never withdrawable. */
  bonus_balance: number;
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

export interface GroupCreditCustomer {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export const listGroupCreditCustomersPage = (
  groupId: string,
  offset: number,
) => {
  const params = new URLSearchParams({
    groups: groupId,
    limit: '100',
    offset: String(offset),
    fields: 'id,email,first_name,last_name',
    order: 'id',
  });
  return getJson<{ customers: GroupCreditCustomer[]; count: number }>(
    `/admin/customers?${params}`,
  );
};

export async function getCustomerGacha(id: string): Promise<CustomerGacha> {
  return getJson<CustomerGacha>(
    `/admin/customers/${encodeURIComponent(id)}/gacha`,
  );
}

// `reasons` keeps only those ledger reasons (the Wallet tab's filter).
export const getCustomerTransactions = (
  id: string,
  page = 0,
  limit = 25,
  reasons?: readonly string[],
) =>
  getJson<{ items: SupportTransaction[]; total: number }>(
    `/admin/customers/${encodeURIComponent(id)}/transactions?limit=${limit}&offset=${page * limit}${reasons?.length ? `&reasons=${reasons.join(',')}` : ''}`,
  );

// `opts` narrows the history server-side (status = vaulted | bought_back |
// delivering | delivered, source = pack | reward). Blank values are OMITTED so
// every filter param follows one rule (see getPulls).
export const getCustomerPulls = (
  id: string,
  page = 0,
  limit = 25,
  opts?: { status?: string; source?: string; sort?: 'newest' | 'value' },
) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (opts?.status) params.set('status', opts.status);
  if (opts?.sort && opts.sort !== 'newest') params.set('sort', opts.sort);
  if (opts?.source) params.set('source', opts.source);
  return getJson<{
    items: SupportPull[];
    total: number;
    /** firm:false = the backend is on its FX display fallback — every
     *  customer sell is being refused while quotes still show amounts. */
    fx?: { rate: number; firm: boolean };
  }>(`/admin/customers/${encodeURIComponent(id)}/pulls?${params}`);
};

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
  /** Null once that staff login no longer exists. */
  admin_email: string | null;
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
  /** Real name (spec 2026-10-06) — what staff match against a Touch 'n Go
   *  lookup of the phone. Null until the customer enters one. */
  real_name?: string | null;
  /** Set once the account verified a phone; the customer can no longer
   *  change it themselves. */
  phone_verified_at?: string | null;
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

// Operator credit adjustment: signed amount, required audit note. The backend
// enforces the $0 balance floor and returns the fresh balance. kind 'bonus'
// moves the spend-only bonus balance instead (ledger reason bonus_grant).
export async function adjustCustomerCredits(
  id: string,
  amount: number,
  note: string,
  idempotencyKey?: string,
  kind?: 'bonus',
  // true = no customer notification (bulk group edit).
  silent?: boolean,
): Promise<{ amount: number; balance: number }> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/customers/${encodeURIComponent(id)}/credits`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        note,
        idempotency_key: idempotencyKey,
        kind,
        notify: silent ? false : undefined,
      }),
    },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
  return (await res.json()) as { amount: number; balance: number };
}

// ── Pack gifts (vault packs) ─────────────────────────────────────────────────

export interface PackGift {
  id: string;
  /** Pack slug. */
  pack_id: string;
  pack_title: string;
  value_myr: number;
  note: string;
  granted_by: string;
  created_at: string;
  opened_at: string | null;
  pull_id: string | null;
  revoked_at: string | null;
  state: 'unopened' | 'opened' | 'revoked' | 'stuck';
}

export const getCustomerPackGifts = (id: string) =>
  getJson<{ gifts: PackGift[] }>(
    `/admin/customers/${encodeURIComponent(id)}/pack-gifts`,
  );

export const grantPackGifts = (
  id: string,
  body: {
    pack_id: string;
    quantity: number;
    note: string;
    idempotency_key: string;
  },
) =>
  postJson<{ gifts: PackGift[] }>(
    `/admin/customers/${encodeURIComponent(id)}/pack-gifts`,
    body,
  );

export const revokePackGift = (giftId: string) =>
  postJson<{ revoked: true }>(
    `/admin/pack-gifts/${encodeURIComponent(giftId)}/revoke`,
    {},
  );

// ── Economy report ───────────────────────────────────────────────────────────

export interface EconomyReport {
  totals: {
    revenue: number;
    payouts: number;
    topups: number;
    adjustments: number;
    /** Shipping + insurance fees collected from customer wallets (fee line, not pack revenue). */
    deliveryFees: number;
    /** Weekly referral commissions paid out (operator promo cost, like rewardPromo). */
    referralCommission: number;
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

// ── Profit report (cash view, spec 2026-10-14-admin-finance-pages §4) ────────

/** Real customers only ('default': no non-default group, not a generated
 *  account) or every account. */
export type CustomerScope = 'default' | 'all';

/** One direction of real money through the gateway. `fees` covers only rows
 *  whose net is on file; `missing_fees` counts the rest (fee = a minimum). */
export interface ProfitCashSide {
  count: number;
  gross: number;
  fees: number;
  missing_fees: number;
  /** Settled rows with no amount on file (settled by hand): gross is a floor. */
  missing_gross: number;
}

export interface ProfitReport {
  as_of: string;
  scope: CustomerScope;
  range: string;
  /** ISO instants, half-open; null for all time. */
  window: { from: string; to: string } | null;
  previous: { from: string; to: string } | null;
  cash: {
    topups: ProfitCashSide;
    withdrawals: ProfitCashSide;
    /** The regional rails' FX spread (Settlement's "Conversion earned"). */
    fx_earned: number;
    kept: number;
    /** null when there is no previous window (all time). */
    previous_kept: number | null;
  };
  /** Right now, whatever the window. */
  owed: {
    wallet_cash: number;
    wallet_bonus: number;
    wallet_no_topup: number;
    /** Payouts requested, not paid yet: already out of the wallets. */
    payouts_in_flight: number;
    /** Closed weeks' referral commission, not paid yet. */
    commission_unpaid: number;
    cards: { count: number; delivering: number; sellback: number };
    /** Cards of players who never topped up: reported, not owed. */
    cards_no_topup: { count: number; sellback: number };
    total: number;
    all_time_kept: number;
    /** Cards delivered, all time: they left as goods, a cost. */
    shipped: { count: number; value: number };
    if_all_cashed_out: number;
  };
  activity: {
    pack_sales: number;
    sellbacks: number;
    promo_given: number;
    delivery_fees: number;
    referral_commission: number;
    adjustments: number;
  };
  packs: EconomyReport['packs'];
}

export type ProfitRange = StatsRange | 'all';

// `from`/`to` are inclusive MYT days (YYYY-MM-DD), sent only for 'custom'.
export async function getProfitReport(
  range: ProfitRange,
  from: string,
  to: string,
  scope: CustomerScope,
): Promise<ProfitReport> {
  const qs = new URLSearchParams({ range, scope });
  if (range === 'custom') {
    qs.set('from', from);
    qs.set('to', to);
  }
  return getJson<ProfitReport>(`/admin/profit-report?${qs.toString()}`);
}

// ── Stats (sign-ups + top-ups) ───────────────────────────────────────────────

export type StatsRange =
  'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month' | 'custom';

export interface StatsFigures {
  signups: number;
  topup_count: number;
  topup_customers: number;
  /** MYR. */
  topup_amount: number;
  first_topup_count: number;
  /** MYR. */
  first_topup_amount: number;
  withdrawal_count: number;
  /** MYR. */
  withdrawal_amount: number;
}

export interface StatsReport {
  as_of: string;
  scope?: CustomerScope;
  /** ISO instants; windows are half-open [from, to). */
  current: { from: string; to: string; stats: StatsFigures };
  previous: { from: string; to: string; stats: StatsFigures };
}

// `from`/`to` are inclusive MYT days (YYYY-MM-DD), sent only for 'custom'.
export async function getStatsReport(
  range: StatsRange,
  from: string,
  to: string,
  scope: CustomerScope = 'all',
): Promise<StatsReport> {
  const qs = new URLSearchParams({ range });
  if (scope !== 'all') qs.set('scope', scope);
  if (range === 'custom') {
    qs.set('from', from);
    qs.set('to', to);
  }
  return getJson<StatsReport>(`/admin/stats?${qs.toString()}`);
}

/** One of GET /admin/stats/leaders' top players for a window. */
export interface PeriodLeader {
  customer_id: string;
  name: string | null;
  email: string | null;
  /** MYR; null for draws, which are counted. */
  amount: number | null;
  /** Top-ups, payouts or pack opens behind it (1 for the biggest top-up). */
  count: number;
}

export interface LeadersReport {
  as_of: string;
  scope: CustomerScope;
  from: string;
  to: string;
  /** Each is null when nobody qualifies in the window. */
  leaders: {
    topped_up: PeriodLeader | null;
    biggest_topup: PeriodLeader | null;
    withdrawn: PeriodLeader | null;
    draws: PeriodLeader | null;
  };
}

export async function getLeaders(
  range: StatsRange,
  scope: CustomerScope = 'all',
): Promise<LeadersReport> {
  const qs = new URLSearchParams({ range });
  if (scope !== 'all') qs.set('scope', scope);
  return getJson<LeadersReport>(`/admin/stats/leaders?${qs.toString()}`);
}

/** GET /admin/stats/online: signed-in players with the storefront open in the
 *  last `window_minutes`. `online` is null when the backend could not read
 *  its presence store. */
export interface OnlineNow {
  as_of: string;
  scope: CustomerScope;
  window_minutes: number;
  online: number | null;
}

export async function getOnlineNow(
  scope: CustomerScope = 'all',
): Promise<OnlineNow> {
  const qs = scope === 'all' ? '' : `?scope=${scope}`;
  return getJson<OnlineNow>(`/admin/stats/online${qs}`);
}

// ── Gateway settlement report (calendar weekly/monthly gateway result) ───────

export type SettlementGranularity = 'week' | 'month';

export interface SettlementDirection {
  count: number;
  gross: number;
  /** Σ net over settled rows whose net is known (NULL = pre-mirror row). */
  net: number;
  /** gross − net over the known-net subset only — a FLOOR when missingNet>0. */
  fee: number;
  /** Settled rows with no net on file: unknown fee, never zero fee. */
  missingNet: number;
  /** Settled rows with no gross on file: unknown gross, never zero gross —
   *  `gross` above is a FLOOR, not a total, whenever this is non-zero. */
  missingGross: number;
}

export interface SettlementPeriod {
  /** MYT calendar bucket key, 'YYYY-MM-DD' (first day of the week/month). */
  period: string;
  deposits: SettlementDirection;
  withdrawals: SettlementDirection;
  ledger: { topupCredited: number; cashoutNet: number };
  /** Gateway-vs-ledger cross-check. Deposits expected ~0; withdrawals is
   *  timing-skewed across bucket boundaries by design (debit at submit,
   *  settle later). */
  delta: { deposits: number; withdrawals: number };
}

export interface SettlementReport {
  granularity: SettlementGranularity;
  /** The rail the report is scoped to; null = every gateway. Amounts are RM
   *  either way (a regional payment at the rate it locked). */
  currency: string | null;
  periods_requested: number;
  since: string;
  periods: SettlementPeriod[];
}

export async function getSettlementReport(
  granularity: SettlementGranularity,
  periods: number,
  currency: string,
  scope: CustomerScope = 'all',
): Promise<SettlementReport> {
  return getJson<SettlementReport>(
    `/admin/payments/settlement?granularity=${granularity}&periods=${periods}&currency=${encodeURIComponent(currency)}${scope === 'all' ? '' : `&scope=${scope}`}`,
  );
}

export interface GatewayBalance {
  /** The rail asked for, and the gateway that serves it (for RM: the active
   *  one). */
  currency: string;
  gateway: string;
  label: string;
  enabled: boolean;
  balance: {
    currency_code: string;
    current: number;
    available: number;
    /** null when the gateway reports no T+1 figure (TGPay family). */
    t1: number | null;
    /** TGPay family: `current` is the pay-in wallet and `available` the
     *  separate payout wallet, not one wallet with part of it locked. */
    separate_wallets: boolean;
  } | null;
  /** The gateway answered but left a wallet out (shown as 0). */
  warning: string | null;
  /** The gateway could not be reached; balance is null. */
  error: string | null;
}

export async function getGatewayBalance(
  currency: string,
): Promise<GatewayBalance> {
  return getJson<GatewayBalance>(
    `/admin/payments/balance?currency=${encodeURIComponent(currency)}`,
  );
}

// ── Payment gateways (plan 130) ─────────────────────────────────────────────

/** Mirrors the backend's PaymentGateway union — the gateways the switch can pick. */
export type PaymentGatewayId = 'tgpay' | 'the7pay';
/** A gateway a ROW may name: a live one, or a retired one ('globepay') whose
 *  settled rows are still history on the audit panel. */
export type HistoricalGatewayId = PaymentGatewayId | (string & {});

// ── Gateway audit (plan 130): gateway = source of truth for money in/out ─────

export interface GatewayAuditTotals {
  count: number;
  gross: number;
  /** Σ net over rows whose net is known — a FLOOR when missing_net > 0. For a
   *  deposit that is what we RECEIVED (amount − fee); for a payout it is what
   *  the wallet PAID (amount + fee — TGPay charges payout fees on top). */
  net: number;
  missing_net: number;
  /** Settled deposits whose amount_settled is NULL (settled by hand) —
   *  `gross` is a FLOOR when > 0. Always 0 on the payout side: a payout's
   *  gross is `amount`, which is NOT NULL. */
  missing_gross: number;
}

export interface GatewayAuditFinding {
  kind: 'deposit' | 'withdrawal';
  /** The gateway the row was created under — live or retired. */
  gateway: HistoricalGatewayId;
  id: string;
  merchant_transaction_id: string;
  gateway_transaction_id: string | null;
  customer_id: string;
  status: string;
  amount: number | null;
  note: string;
  audited_at: string | null;
  /** Who acknowledged this finding on Settlement and when, while the note is
   *  still the one they acknowledged. Absent from an older backend. */
  acknowledged?: {
    by: string | null;
    at: string | null;
    /** From the admin action log; absent from an older backend. */
    reason?: string | null;
  } | null;
}

export interface GatewayAudit {
  currency: string;
  /** The rail's gateway (for RM: the active one). Its live wallet is
   *  getGatewayBalance's. */
  gateway: HistoricalGatewayId;
  last_audited_at: string | null;
  /** Rows the gateway disagrees with. */
  findings_total: number;
  /** Rows from a retired gateway, which can never be checked again: listed,
   *  counted apart. Absent from a backend older than this field. */
  retired_total?: number;
  /** Findings an operator acknowledged: listed last, greyed, never in
   *  findings_total. Absent from a backend older than this field. */
  acknowledged_total?: number;
  totals: { deposits: GatewayAuditTotals; withdrawals: GatewayAuditTotals };
  /** Settled totals of every OTHER gateway that ever moved money, so a switch
   *  never hides the previous gateway's history from this page. */
  history: {
    gateway: HistoricalGatewayId;
    deposits: GatewayAuditTotals;
    withdrawals: GatewayAuditTotals;
  }[];
  findings: GatewayAuditFinding[];
}

/** Settlement's Acknowledge: the note is the one on screen, so a finding the
 *  audit has re-worded since is refused (409) rather than acknowledged blind. */
export const acknowledgeAuditFinding = (body: {
  kind: 'deposit' | 'withdrawal';
  id: string;
  note: string;
  reason: string;
}) =>
  postJson<{ acknowledged: boolean }>(
    '/admin/payments/audit/acknowledge',
    body,
  );

export async function getGatewayAudit(currency: string): Promise<GatewayAudit> {
  return getJson<GatewayAudit>(
    `/admin/payments/audit?currency=${encodeURIComponent(currency)}`,
  );
}

// ── Active payment gateway switch (plan 130 §runtime switch) ────────────────

export interface PaymentGatewaySetting {
  /** What the backend is using right now. */
  active: PaymentGatewayId;
  /** The persisted admin choice; null = env default applies. */
  setting: string | null;
  env_default: PaymentGatewayId;
  gateways: { id: PaymentGatewayId; label: string; configured: boolean }[];
  /** One Settlement tab each: RM first, then every regional rail. */
  currencies: string[];
  /** After a switch: non-blocking findings from the live check (e.g. an
   *  empty payout wallet). */
  warnings?: string[];
}

/** The switch was refused by the live check; `problems` say why, and the
 *  operator may resend with `force: true` ("Switch anyway"). */
export type GatewayPreflightRefusal = {
  type: 'gateway_preflight_failed';
  problems: string[];
  warnings: string[];
  can_force: true;
};

export const gatewayPreflightRefusal = (
  err: unknown,
): GatewayPreflightRefusal | null => {
  const data = (err as { data?: unknown } | null)?.data as
    Partial<GatewayPreflightRefusal> | undefined;
  return data?.type === 'gateway_preflight_failed' &&
    Array.isArray(data.problems)
    ? (data as GatewayPreflightRefusal)
    : null;
};

export async function getPaymentGateway(): Promise<PaymentGatewaySetting> {
  return getJson<PaymentGatewaySetting>('/admin/payments/gateway');
}

export async function savePaymentGateway(input: {
  gateway: PaymentGatewayId;
  reason: string;
  /** Switch even though the live check found problems. */
  force?: boolean;
}): Promise<PaymentGatewaySetting> {
  return postJson<PaymentGatewaySetting>('/admin/payments/gateway', input);
}

// ── Withdrawal controls (2026-10-17) ────────────────────────────────────────
// The Withdraw and Touch 'n Go switches, a daily closed window for each
// (Malaysia time, may wrap past midnight) and the TNG minimum. Mirrors the
// API's withdrawal-controls.ts.

export interface DailyClosure {
  on: boolean;
  /** "HH:MM", Malaysia time. */
  close_at: string | null;
  reopen_at: string | null;
}
export interface ChannelControl {
  open: boolean;
  /** ISO instant a switched-off channel reopens by itself; null = only an
   *  admin reopens it. */
  off_until: string | null;
  schedule: DailyClosure;
}
export interface WithdrawalControls {
  withdrawals: ChannelControl;
  tng: ChannelControl & { min_rm: number | null };
}
export interface ChannelStatus {
  open: boolean;
  /** ISO; null while closed = only an admin can reopen it. */
  reopens_at: string | null;
}
export interface WithdrawalControlsView {
  controls: WithdrawalControls;
  status: { withdrawals: ChannelStatus; tng: ChannelStatus };
  /** What the server config allows whatever the switches say. */
  env: { withdrawals: boolean; tng: boolean };
  tng_min_floor_rm: number;
}

export async function getWithdrawalControls(): Promise<WithdrawalControlsView> {
  return getJson<WithdrawalControlsView>('/admin/payments/withdrawal-controls');
}

export async function saveWithdrawalControls(
  input: WithdrawalControls & { reason: string },
): Promise<WithdrawalControlsView> {
  return postJson<WithdrawalControlsView>(
    '/admin/payments/withdrawal-controls',
    input,
  );
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

// One holding in the operator's own PriceCharting collection. Carries no FMV:
// `value_usd` is PriceCharting's valuation of that offer, shown for triage only —
// the import re-reads the per-grade price so market_value matches what the
// nightly sync will write. A 503 means PRICECHARTING_API_TOKEN is not
// configured; surface the message and use the search page instead.
export interface PcOffer {
  /** Per-row id — always present; the API drops rows without one. */
  offer_id: string;
  product_id: string;
  name: string;
  set: string;
  /** PriceCharting's own grade tag, verbatim ("PSA 10", "Graded 9"). */
  include: string;
  condition: string;
  value_usd: number | null;
  /** `include` mapped to a priceable grade tier, or null — operator picks. */
  grade: string | null;
  image: string | null;
  /** Upstream `is-card`: a real collection also holds games and hardware. */
  is_card: boolean;
}

/** One page (~30) of the collection plus the cursor for the next one; an empty
 *  cursor means the collection is exhausted. Paged rather than walked server
 *  side because the collection runs to five figures. */
export async function getPriceChartingCollection(
  cursor = '',
): Promise<{ offers: PcOffer[]; cursor: string; foreign_dropped: number }> {
  return getJson<{
    offers: PcOffer[];
    cursor: string;
    /** Rows upstream said belong to another account; the API dropped them. */
    foreign_dropped: number;
  }>(
    '/admin/pricecharting/collection' +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
  );
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

// ── Regional conversion (A3Pay: SGD — payment-fx.ts) ─────────────────────────

export interface PaymentFxQuote {
  currency: string;
  mid: number;
  /** Fee switched on? Off = both rates are the mid. */
  feeEnabled: boolean;
  /** Percent of the mid each way (0 while switched off). */
  depositFeePercent: number;
  payoutFeePercent: number;
  /** RM credited per 1 unit paid in. */
  depositRate: number;
  /** RM debited per 1 unit paid out. */
  payoutRate: number;
  source: 'manual' | 'feed';
}

export interface PaymentFxState {
  currency: string;
  pair: string;
  /** "S$1" — how one unit reads in labels. */
  unit: string;
  /** Sane band for a manual rate (RM per unit); null = unbounded. */
  manual_band: { min: number | null; max: number | null };
  feed_rate: number | null;
  source: string | null;
  fetched_at: string | null;
  manual_override: boolean;
  manual_rate: number | null;
  /** null = never configured: the rail stays paused until saved once. */
  fee_enabled: boolean | null;
  /** Percent of the mid; kept while the fee is switched off. */
  deposit_fee_percent: number;
  payout_fee_percent: number;
  max_fee_percent: number;
  quote: PaymentFxQuote | null;
  quote_error: string | null;
  earnings: {
    deposits: { count: number; rm: number };
    payouts: { count: number; rm: number };
    total_rm: number;
  };
}

export const getPaymentFx = (currency: string) =>
  getJson<PaymentFxState>(
    `/admin/payments/fx?currency=${encodeURIComponent(currency)}`,
  );

export const setPaymentFx = (body: {
  currency: string;
  fee_enabled: boolean;
  deposit_fee_percent: number;
  payout_fee_percent: number;
  manual_override: boolean;
  manual_rate: number | null;
  reason: string;
}) => postJson<PaymentFxState>('/admin/payments/fx', body);

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
  /** MYR wallet charge stamped at request (2026-08-25); null = pre-fee order
   *  or reward-prize shipment (nothing charged). Optional: an older backend
   *  omits the fields entirely. */
  shipping_fee?: number | null;
  insurance_fee?: number | null;
  proof_images: string[];
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  items: AdminDeliveryItem[];
  /** The shipment tracker's last carrier check (list route only). */
  tracking_snapshot?: DeliveryTrackingSnapshot | null;
}

/** Mirrors the backend TrackingSnapshot (modules/packs/shipment-tracking.ts). */
export interface DeliveryTrackingSnapshot {
  tracking_number: string;
  carrier: 'ninjavan' | 'poslaju' | 'dhl_ecommerce' | null;
  state:
    | 'delivered'
    | 'in_transit'
    | 'problem'
    | 'not_found'
    | 'unknown_carrier';
  event: string | null;
  event_at: string | null;
  delivered_at: string | null;
  checked_at: string;
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
  sort?: string,
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
  // `<column>:<asc|desc>`; the route allowlists the column and falls back to
  // created_at:desc. Omitted = server default (newest first).
  if (sort) params.set('sort', sort);
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

// Check every shipped order with its carrier now and complete the delivered
// ones — the same run as the 2-hourly job.
export const checkDeliveryTracking = () =>
  postJson<{
    checked: number;
    completed: string[];
    problems: string[];
    failed: string[];
  }>('/admin/delivery-orders/track', {});

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

// ── Daily Rewards (level-range vouchers) ────────────────────────────────────
// The VIP-tier daily boxes were removed 2026-08-25 (operator: the concept is
// dead); what is left of this surface is the voucher ladder.

export interface VoucherRangeDTO {
  from: number;
  to: number;
  amount_myr: number;
}

export interface VoucherLadderDTO {
  levels: { level: number; amount_myr: number }[];
  ranges: VoucherRangeDTO[];
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
  frame_unlock: boolean;
}

export const getVipLevels = () =>
  getJson<{ levels: VipLevelDTO[] }>('/admin/vip-levels');

// Replace-all the ladder. Audited edit; `reason` mandatory. Throws
// Error(message) on a 400 (httpError surfaces the backend MedusaError).
export const saveVipLevels = (body: {
  levels: VipLevelDTO[];
  reason: string;
}) => postJson<{ levels: VipLevelDTO[] }>('/admin/vip-levels', body);

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
}) =>
  postJson<{ stages: ChallengeStageDTO[] }>('/admin/challenge/stages', body);

/** One Weekly Challenge queued to take over later. `applied_at` non-null means
 *  it already went live (the hourly settle job promoted it); a due row that is
 *  still null failed to promote and is being retried. */
export interface ChallengeScheduleDTO {
  id: string;
  starts_at: string;
  label: string | null;
  applied_at: string | null;
  /** Start has passed, decided on the SERVER's clock — the one the promotion
   *  job runs on. `due && !applied_at` is a promotion that hasn't landed. */
  due: boolean;
  stages: ChallengeStageDTO[];
}

export const getChallengeSchedules = () =>
  getJson<{ schedules: ChallengeScheduleDTO[] }>('/admin/challenge/schedule');

export const createChallengeSchedule = (body: {
  starts_at: string;
  label: string | null;
  stages: ChallengeStageDTO[];
  reason: string;
}) =>
  postJson<{ schedule: ChallengeScheduleDTO }>(
    '/admin/challenge/schedule',
    body,
  );

/** Edit a QUEUED edition in place. The backend refuses once it has gone live. */
export const updateChallengeSchedule = (
  id: string,
  body: {
    starts_at: string;
    label: string | null;
    stages: ChallengeStageDTO[];
    reason: string;
  },
) =>
  postJson<{ schedule: ChallengeScheduleDTO }>(
    `/admin/challenge/schedule/${encodeURIComponent(id)}`,
    body,
  );

export async function deleteChallengeSchedule(id: string): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/challenge/schedule/${encodeURIComponent(id)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
}

/** One settled week, for the Winners selector. `skipped` counts prize cards the
 *  settlement could NOT grant for stock — the manual-fulfilment queue. */
export interface ChallengeWeekSummaryDTO {
  weekStart: string;
  winners: number;
  credits: number;
  cards: number;
  skipped: number;
}

export interface ChallengeWinnerDTO {
  rank: number;
  customer_id: string;
  customer_email: string | null;
  credits: number;
  cards: {
    card_id: string;
    name: string | null;
    image: string | null;
    qty: number;
    status: string;
    /** Card row no longer exists. On a skipped row this separates the
     *  stock-era backlog (retro-grantable) from a genuinely manual one. */
    card_missing: boolean;
  }[];
  pool_myr: number | null;
  unlocked_stages: number[];
}

export const getChallengeWinners = (week?: string) =>
  getJson<{
    weeks: ChallengeWeekSummaryDTO[];
    week: string | null;
    winners: ChallengeWinnerDTO[];
  }>(
    `/admin/challenge/winners${week ? `?week=${encodeURIComponent(week)}` : ''}`,
  );

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

// ── Tier defaults (price range per rarity tier) ──────────────────────────────

/** RM display-price range; a null bound is open on that side. */
export interface TierRangeDTO {
  min: number | null;
  max: number | null;
}

/** Keyed by rarity. A missing tier is unconfigured; {} = feature off. */
export interface TierSettingsDTO {
  ranges: Record<string, TierRangeDTO>;
}

export const getTierSettings = () =>
  getJson<TierSettingsDTO>('/admin/tier-settings');

// Singleton REPLACE: the whole map is written each save (an omitted tier is
// cleared server-side, deliberately — not a merge).
export const saveTierSettings = (body: {
  ranges: Record<string, TierRangeDTO>;
  reason: string;
}) => postJson<TierSettingsDTO>('/admin/tier-settings', body);

// ── Pixel-Pokémon library (Pokédex) ──────────────────────────────────────────

export interface PixelPokemonRow {
  id: string;
  name: string;
  dex: number | null;
  /** The deck ('pokemon' | 'one-piece'): Pokémon are numbered by `dex`,
   *  every other franchise by `number`. */
  franchise: string;
  number: number | null;
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
  franchise?: string;
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
  if (params.franchise) qs.set('franchise', params.franchise);
  if (params.type) qs.set('type', params.type);
  if (params.variant) qs.set('variant', params.variant);
  if (params.custom) qs.set('custom', params.custom);
  return getJson<PixelPokemonPage>(`/admin/pixel-pokemon?${qs}`);
}

export interface CreatePixelPokemonBody {
  name: string;
  franchise?: string;
  dex?: number | null;
  number?: number | null;
  variant?: string;
  types?: string[];
  image_url: string;
}

// Add a custom pixel-pokémon (sprite already uploaded via uploadImage → url).
export const createPixelPokemon = (body: CreatePixelPokemonBody) =>
  postJson<{ pixel_pokemon: PixelPokemonRow }>('/admin/pixel-pokemon', body);

// Gateway deposits (GET /admin/payments/deposits) — the operator's only
// window into money-in. 'stale' means the row is still pending past the
// reconciliation sweep's window — mostly a customer who walked away, which the
// next sweep expires. 'stuck' is the narrow subset the dashboard flags: still
// pending two sweeps later with a gateway id, i.e. possibly a payment that
// landed at the gateway without ever being credited here.
export type GatewayDepositView =
  'pending' | 'settled' | 'failed' | 'expired' | 'all';

export interface GatewayDeposit {
  id: string;
  merchant_transaction_id: string;
  gateway_transaction_id: string | null;
  customer_id: string;
  customer_email: string | null;
  amount_requested: number;
  /** The currency the customer paid / was paid in ('MYR' unless a regional
   *  rail such as A3Pay), and that amount. null on RM rows. */
  currency: string;
  gateway_amount: number | null;
  amount_settled: number | null;
  /** Settled gross minus the gateway's fee. NULL = settled before the mirror
   *  (unknown fee), never "no fee". */
  net_amount: number | null;
  /** The BANK's own references for the transfer (gateway_transaction_id is
   *  the gateway's). What support quotes in a dispute. NULL on pre-mirror rows. */
  bank_reference_no: string | null;
  unique_reference_no: string | null;
  payment_method_code: string;
  // 'expired' = the reconcile sweep stopped chasing it, but the gateway never
  // ruled on it — NOT a synonym for 'failed', and still creditable by a late
  // callback or the sweep's second scan tier. The withdrawal type below
  // deliberately has no such value: expiring a payout would confiscate a debit.
  status: 'pending' | 'settled' | 'failed' | 'expired';
  gateway_status: number | null;
  created_at: string;
  settled_at: string | null;
  stale: boolean;
  stuck: boolean;
}

export interface GatewayDepositsResponse {
  total: number;
  offset: number;
  limit: number;
  status: GatewayDepositView;
  deposits: GatewayDeposit[];
}

export function getGatewayDeposits(
  page: number,
  status: GatewayDepositView,
  pageSize = 50,
  sort?: string,
  /** One customer's attempts only (the player page's Payments tab). */
  customerId?: string,
): Promise<GatewayDepositsResponse> {
  const params = new URLSearchParams({
    status,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  // `<column>:<asc|desc>`, allowlisted server-side. OMITTED when unset — the
  // route's default order is status-dependent (pending = oldest-first work
  // queue) and an always-sent sort would silently flatten that.
  if (sort) params.set('sort', sort);
  if (customerId) params.set('customer_id', customerId);
  return getJson<GatewayDepositsResponse>(`/admin/payments/deposits?${params}`);
}

// Gateway withdrawals (GET /admin/payments/withdrawals) — the money-OUT
// mirror of the deposits window. 'stale' = still pending past the sweep's
// window; for a withdrawal that means a customer already debited with no
// payout confirmed and no refund, i.e. the row to chase first.
//
// 'held' (Task 6, plan 094) is the operator-facing DEFAULT view: a held row
// is debited, above the approval threshold, and awaiting a human's approve or
// deny — it outranks 'pending' because a customer waiting on a HUMAN is a
// different kind of waiting than a customer waiting on the gateway. The
// backend's own default (parseStatusFilter) is left on 'pending' — this SPA
// always sends `status` explicitly (see getGatewayWithdrawals below), so the
// page's default view is what actually decides what an operator sees first.
export type GatewayWithdrawalView =
  'held' | 'pending' | 'settled' | 'failed' | 'all';

export interface GatewayWithdrawal {
  id: string;
  merchant_transaction_id: string;
  gateway_transaction_id: string | null;
  customer_id: string;
  customer_email: string | null;
  amount: number;
  /** The currency the customer paid / was paid in ('MYR' unless a regional
   *  rail such as A3Pay), and that amount. null on RM rows. */
  currency: string;
  gateway_amount: number | null;
  /** What the gateway says it actually paid — durable form of the settled-
   *  amount disagreement that used to be log-only. NULL on pre-mirror rows. */
  amount_settled: number | null;
  /** Settled minus their payout fee. NULL = unknown, never "no fee". */
  net_amount: number | null;
  /** The BANK's references for the transfer — not account data. */
  bank_reference_no: string | null;
  unique_reference_no: string | null;
  bank_code: string;
  /** Null for a code the bank registry no longer knows. */
  bank_name: string | null;
  /** MASKED (`••••1234`) — the list never serves a full account number. The
   *  full value comes one row at a time from getWithdrawalAccount. */
  account_number: string;
  account_holder_name: string;
  status: 'held' | 'pending' | 'settled' | 'failed';
  gateway_status: number | null;
  /** Why the payout died — the gateway's own codes, a sweep verdict, or the
   *  admin who denied it. Null on rows that never failed, and on the ten
   *  pre-2026-08-12 failures that predate the column. */
  failure_reason: string | null;
  /** How we answered their Payout Verification, stamped on EVERY hit we can
   *  match to a row. Null does NOT prove their call never came: a decrypt or
   *  signature failure is refused before we know which withdrawal it belongs
   *  to, and rows created before this column exist keep it null forever. It
   *  narrows the search to those three, and the HTTP access log separates
   *  them. */
  verify_outcome: string | null;
  created_at: string;
  settled_at: string | null;
  stale: boolean;
  /** The customer's funds-freeze state, as of this page load — a PREVIEW,
   *  not a guarantee: ./[id]/approve re-checks it live at click time, so a
   *  freeze that lands between two polls can still refuse an approve this
   *  said `false` a moment ago. Surfaced so an approver sees the reason
   *  BEFORE clicking into that refusal, not just after. */
  frozen: boolean;
}

export interface GatewayWithdrawalsResponse {
  total: number;
  offset: number;
  limit: number;
  status: GatewayWithdrawalView;
  withdrawals: GatewayWithdrawal[];
}

export function getGatewayWithdrawals(
  page: number,
  status: GatewayWithdrawalView,
  pageSize = 50,
  sort?: string,
  /** One customer's payouts only (the player page's Payments tab). */
  customerId?: string,
): Promise<GatewayWithdrawalsResponse> {
  const params = new URLSearchParams({
    status,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  // Same contract as getGatewayDeposits: omitted = status-dependent default.
  if (sort) params.set('sort', sort);
  if (customerId) params.set('customer_id', customerId);
  return getJson<GatewayWithdrawalsResponse>(
    `/admin/payments/withdrawals?${params}`,
  );
}

/** Reveal ONE withdrawal's full destination account (the list masks it).
 *  Deliberately not a react-query hook and not prefetched: the backend logs
 *  and rate-limits every call, so it must fire only when an operator asks. */
export function getWithdrawalAccount(
  id: string,
): Promise<{ id: string; account_number: string }> {
  return getJson<{ id: string; account_number: string }>(
    `/admin/payments/withdrawals/${encodeURIComponent(id)}/account`,
  );
}

// ── Held-withdrawal approval queue (Task 6, plan 094) ────────────────────────

/** Mirrors ./[id]/approve's response verbatim (see its route.ts) — three real
 *  shapes collapse into `approved`/`transaction_id`: approved:true with an id
 *  is a submitted payout, approved:true with a null id is a submit whose
 *  gateway outcome is ambiguous (left pending for the reconcile sweep), and
 *  approved:false is the idempotent no-op (the row was not 'held' anymore —
 *  another click or another admin already resolved it). `status` can be
 *  STALE on the no-op branch (the route reads it once, before the claim it
 *  then fails to make — see approve/route.ts), so callers must not treat it
 *  as the row's current truth; see withdrawal-outcome.ts's classifier, which
 *  deliberately never reads this field. */
export interface WithdrawalApproveResult {
  id: string;
  status: string;
  transaction_id: string | null;
  approved: boolean;
}

/** Claim a HELD withdrawal and submit it to the gateway. Refuses (thrown,
 *  via httpError) when the payout channel is closed, the customer is frozen,
 *  or the row was never actually debited — each with its own specific
 *  MedusaError message, which is what reaches the operator's toast. No body:
 *  the route acts only on `:id` and the session's admin actor. */
export const approveWithdrawal = (id: string) =>
  postJson<WithdrawalApproveResult>(
    `/admin/payments/withdrawals/${encodeURIComponent(id)}/approve`,
    {},
  );

/** Mirrors ./[id]/deny's response verbatim. `refunded:false` is the
 *  never-debited edge case (a held row whose debit never landed, closed
 *  without minting a refund) — distinct from `refunded:true`'s normal path,
 *  and from a thrown NOT_ALLOWED (wrong status: only held/failed can be
 *  denied) or NOT_FOUND. */
export interface WithdrawalDenyResult {
  id: string;
  status: string;
  refunded: boolean;
}

/** Claim a HELD (or already-'failed', for the crash-recovery re-run — see
 *  the route's own comment) withdrawal, refund it, and close it. No body,
 *  same reason as approve. */
export const denyWithdrawal = (id: string) =>
  postJson<WithdrawalDenyResult>(
    `/admin/payments/withdrawals/${encodeURIComponent(id)}/deny`,
    {},
  );

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
  /** The EFFECTIVE player group's name (the odds engine's rule); null = the
   *  default group. groups[0] is just whichever membership came first. */
  player_group: string | null;
  vip_level: number;
  wallet_balance: number;
  vault_value: number;
  vault_count: number;
  /** Turnover; this and the three below cover the list's `window`. */
  total_spend: number;
  /** Top-ups (Σ topup ledger rows). */
  total_topup: number;
  /** Withdrawals (Σ cashout rows, positive; refunds net out). */
  total_withdrawn: number;
  /** total_topup − total_withdrawn: cash the player has put in, net. */
  total_contribution: number;
  total_pulls: number;
  registered_at: string;
  last_spend_at: string | null;
  /** Funds hold. Orthogonal to `disabled` (login block). */
  frozen: boolean;
  disabled: boolean;
  /** Has this account ever completed SMS verification? Orthogonal to both flags
   *  above: an unverified account can log in and browse, it just cannot top up
   *  or request delivery while the phone gate is on. */
  phone_verified: boolean;
  /** Real name (spec 2026-10-06), null until entered. */
  real_name: string | null;
  /** Partner account (spec 2026-09-09): 'group' when their player group is a
   *  partner group (its rate pays them), 'manual' for the per-customer flag,
   *  null for an ordinary account. */
  partner: 'group' | 'manual' | null;
  /** The partner group's name when `partner === 'group'` — the EFFECTIVE
   *  group, which `groups[0]` need not be. */
  partner_group: string | null;
}

export interface PlayersPage {
  total: number;
  offset: number;
  limit: number;
  /** The period the turnover and money in/out columns cover; null = all time. */
  window: { from: string; to: string } | null;
  players: PlayerRow[];
}

/** GET /admin/players' ?range=: a Stats preset, or custom with its MYT days
 *  (YYYY-MM-DD). None = all time. */
export type PlayersPeriod = { range: StatsRange; from?: string; to?: string };

// `sort` is `<column>:<asc|desc>`; the route allowlists the column and falls
// back to created_at. `group` is 'default' (everyone outside a non-default
// group) or a group id.
export const listPlayers = (
  page = 0,
  q?: string,
  limit = 50,
  sort = 'created_at:desc',
  group?: string,
  period?: PlayersPeriod,
) =>
  getJson<PlayersPage>(
    `/admin/players?limit=${limit}&offset=${page * limit}&sort=${encodeURIComponent(sort)}${q ? `&q=${encodeURIComponent(q)}` : ''}${group ? `&group=${encodeURIComponent(group)}` : ''}${
      period
        ? `&range=${period.range}${period.range === 'custom' ? `&from=${encodeURIComponent(period.from ?? '')}&to=${encodeURIComponent(period.to ?? '')}` : ''}`
        : ''
    }`,
  );

/** One generated partner account — what POST /admin/players answers and what
 *  GET /admin/players/export lists. `password` is the plaintext the operator
 *  hands out. */
export interface CreatedPlayer {
  id: string;
  email: string;
  password: string;
  name: string | null;
  group: string | null;
  created_at: string;
}

// Partner account generator: `count` (1–50) logins with server-generated
// email + password, filed into `group_id` (null = DEFAULT, same contract as
// setCustomerGroup). `display_name` null = auto; typed = exact for the first
// account, numbered variants for the rest (422 when taken).
export const createPlayers = (body: {
  count: number;
  display_name: string | null;
  group_id: string | null;
}) => postJson<{ players: CreatedPlayer[] }>('/admin/players', body);

// Every generated partner login (or one batch by ids) as a .xlsx download.
// Same blob-URL dance as exportInventoryXlsx, for the reasons noted there.
export async function exportPartnerAccountsXlsx(ids?: string[]): Promise<void> {
  const qs = ids?.length ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
  const res = await fetch(`${__BACKEND_URL__}/admin/players/export${qs}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw await httpError(res);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `partner-accounts-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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

/** One window of a player's money: top-ups and withdrawal requests (net of
 *  refunds) from the credit ledger, the Players list's own sums. */
export interface CustomerMoneyPeriod {
  topups: { count: number; amount: number };
  withdrawals: { count: number; amount: number };
  /** top-ups − withdrawals: the Players list's "Total contribution". */
  contribution: number;
}

/** GET /admin/customers/:id/money: the player page's money card. `cash`,
 *  `owed` and `activity` are the Profit report's, all time, for this
 *  player alone. */
export interface CustomerMoney {
  as_of: string;
  customer_id: string;
  windows: Record<'today' | 'd7' | 'month', { from: string; to: string }>;
  periods: Record<'today' | 'd7' | 'month' | 'all', CustomerMoneyPeriod>;
  last: {
    topup_at: string | null;
    withdrawal_at: string | null;
    open_at: string | null;
  };
  /** The wallet as the player's withdraw button sees it (walletSummary). */
  wallet: {
    balance: number;
    withdrawable: number;
    /** Spend-only bonus inside the balance. */
    bonus: number;
    frozen: boolean;
    /** Never topped up = nothing may be withdrawn or shipped. */
    has_topup: boolean;
    /** Deposits must be spent on packs before they can leave. */
    playthrough: { deposited: number; used: number; remaining: number };
  };
  cash: ProfitReport['cash'];
  owed: ProfitReport['owed'];
  activity: ProfitReport['activity'];
  play: {
    /** Cards real money won, at draw-time value × today's rate, each in its
     *  normal (non-bonus) share: the leaderboard's basis. */
    cards_won: { count: number; value: number };
    /** cards_won as a percent of pack spend; null with no spend. */
    return_pct: number | null;
  };
}

export const getCustomerMoney = (id: string) =>
  getJson<CustomerMoney>(`/admin/customers/${encodeURIComponent(id)}/money`);

/** Core Medusa customer record (the Profile tab), not the gacha projection. */
export interface AdminCustomerDetail {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  /** Player group membership. Exclusive in practice (see setPlayerGroup on the
   *  backend), so the Profile tab reads groups[0] — but it stays an ARRAY
   *  because the prebuilt /customer-groups screen can still add a second.
   *
   *  `metadata` is carried because isDefaultPlayerGroup identifies the default
   *  group by its MARKER first and only falls back to the name. Without it,
   *  a renamed default group stops being recognised here — exactly the case
   *  the marker exists for — and the duplicate-membership repair would pick
   *  the wrong membership as current. */
  groups?: {
    id: string;
    name: string;
    metadata?: Record<string, unknown> | null;
  }[];
  /** The player's saved shipping addresses. */
  addresses?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    address_1: string | null;
    address_2: string | null;
    city: string | null;
    province: string | null;
    postal_code: string | null;
    country_code: string | null;
    phone: string | null;
    is_default_shipping?: boolean;
  }[];
}

// `+groups.*` APPENDS to Medusa's default field set rather than replacing it —
// a bare `fields=groups.id` would drop email/phone/created_at and blank the
// Profile tab. `groups` is on the route's `allowed` list, so this is a
// supported relation, not a query smuggled past the validator.
export const getCustomerDetail = (id: string) =>
  getJson<{ customer: AdminCustomerDetail }>(
    `/admin/customers/${encodeURIComponent(id)}?fields=%2Bgroups.id,%2Bgroups.name,%2Bgroups.metadata,%2Baddresses.*`,
  );

// ── Epic 3 (Odds) ────────────────────────────────────────────────────────────

// Medusa's NATIVE admin customer-groups API for list + create; odds-set edits
// go through the repo's audited /odds-set route. The prebuilt @mercurjs/admin
// bundle owns edit/membership at /customer-groups; this app reads the list and
// sets `metadata.odds_set` (1|2|3), which the
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

// Repo-side route, not the native metadata write: the server records the
// change (before/after, who) and refuses the DEFAULT group, and the native
// update now rejects `metadata.odds_set` so this is the only way to change it.
// Same response shape as the native route.
export const setGroupOddsSet = (id: string, set: 1 | 2 | 3) =>
  postJson<{ customer_group: AdminCustomerGroup }>(
    `/admin/customer-groups/${encodeURIComponent(id)}/odds-set`,
    { odds_set: set },
  );

// The native create route takes `metadata` in the same body as `name`, so the
// group is born with its odds set — no create-then-patch window in which a new
// group silently plays set 1.
export const createCustomerGroupAdmin = (name: string, set: 1 | 2 | 3) =>
  postJson<{ customer_group: AdminCustomerGroup }>('/admin/customer-groups', {
    name,
    metadata: { odds_set: set },
  });

/** Partner policy on a group (spec 2026-09-09) — repo-side route: bounds,
 *  the DEFAULT refusal and the audit row live on the server. A null rate turns
 *  the group back into an ordinary group and clears both toggles. */
export const setGroupPolicy = (
  id: string,
  policy: GroupPolicy,
  reason: string,
) =>
  postJson<{ customer_group: AdminCustomerGroup }>(
    `/admin/customer-groups/${encodeURIComponent(id)}/policy`,
    { ...policy, reason },
  );

/** How many players are in one group. Only `count` is used — limit=1 keeps the
 *  payload one row wide on a group with 50k members (limit=0 is not a
 *  documented "count only" in Medusa, so it isn't relied on here). */
export const countCustomersInGroup = (groupId: string) =>
  getJson<{ count: number }>(
    `/admin/customers?limit=1&fields=id&groups=${encodeURIComponent(groupId)}`,
  ).then((r) => r.count);

/** Move a player into ONE group (repo-side route — exclusive, single request).
 *  `groupId: null` returns them to the default group. */
export const setCustomerGroup = (customerId: string, groupId: string | null) =>
  postJson<{ group: { id: string; name: string } }>(
    `/admin/customers/${encodeURIComponent(customerId)}/group`,
    { group_id: groupId },
  );

// ── Epic 4 (Ledger) ──────────────────────────────────────────────────────────

/** The ledger event types (POLYCARD-BACK §5.1). */
export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'AD' | 'WP' | 'WD' | 'RF';

/** One row of GET /admin/ledger. Deltas are MYR and NULLABLE — an event that
 *  touches only one side leaves the other null (not 0). `payload` is the raw
 *  per-type detail blob, rendered as JSON in the row expander. */
export interface AdminLedgerRow {
  id: string;
  display_id: string;
  type: LedgerType;
  customer: { id: string; email: string; name: string | null };
  occurred_at: string;
  wallet_delta: number | null;
  vault_delta: number | null;
  payload: Record<string, unknown>;
}

export interface AdminLedgerPage {
  total: number;
  offset: number;
  limit: number;
  entries: AdminLedgerRow[];
}

// `from`/`to` are plain YYYY-MM-DD, exactly what `<input type="date">` emits.
// Do NOT convert them here: the route reads a date-only bound as the operator's
// MYT calendar day and makes the range half-open, so a client-side shift would
// double-apply the offset (see modules/packs/ledger.ts parseMytBound).
export const listLedger = (
  page = 0,
  opts: {
    type?: LedgerType;
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
    /** `<column>:<asc|desc>`; allowlisted server-side (occurred_at |
     *  display_id | type), falls back to occurred_at:desc. */
    sort?: string;
  } = {},
) => {
  const limit = opts.limit ?? 50;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (opts.type) params.set('type', opts.type);
  if (opts.q) params.set('q', opts.q);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.sort) params.set('sort', opts.sort);
  return getJson<AdminLedgerPage>(`/admin/ledger?${params.toString()}`);
};
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
  /** The goods receive note this invoice was transferred from (spec
   *  2026-10-28). A reversal of a transferred invoice carries the same id —
   *  the server copies it — so both read "From GRN-…". */
  from_grn_id: string | null;
  from_grn_display_no: string | null;
  created_at: string;
  total_qty: number;
  subtotal: number;
  total_fmv: number;
}

// agent_email is NOT omitted: GET /:id joins the user module the same way the
// list route does, so both pages name the same person for one invoice.
export interface AdminPurchaseInvoiceDetail extends Omit<
  AdminPurchaseInvoice,
  'total_qty' | 'subtotal' | 'total_fmv'
> {
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
  /** Transfer from an open GRN. The lines must equal the GRN's as a multiset
   *  of (card_handle, qty); only unit_cost is the operator's. Never together
   *  with reverses_invoice_id — the server refuses the pair. */
  from_grn_id?: string | null;
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
 *  `cost` and `counter` are THREE-STATE and the distinction is load-bearing:
 *  `null` = no purchase history / tracks no inventory at all; `0` = bought and
 *  free / tracked with nothing shippable. The route builds both with `??` and
 *  never `||` (inventory-view.ts says so in as many words) — so nothing on this
 *  side may collapse them with a truthiness test either. `fmv`/`price` are null
 *  when the product carries no FMV at all, never NaN and never 0-by-accident.
 *
 *  Stock buckets (spec 2026-10-28), in the Stock page's column order:
 *  `to_procure` = max(0, requested + ready_to_ship − on_hand); `on_hand` = the
 *  PHYSICAL cards on the shelf, received (GRN lines + invoice lines not
 *  transferred from a GRN) minus shipped — never null, and negative only when
 *  more shipped than was ever received (missing history), which the pages show
 *  in the error colour; `requested` = orders in requested + processed;
 *  `ready_to_ship`; `shipped`. `counter` is the OLD Medusa stock counter,
 *  received minus WON (negative = units owed to winners) — what prize takes
 *  draw from, so the Lucky Draw picker reads it, not `on_hand`.
 *
 *  All money is MYR and arrives as plain JS numbers (the route folds through
 *  displayMarketPrice / weightedAverageCost, not through a bigNumber getter),
 *  so it feeds rm() unwrapped — see the Number() note on
 *  AdminPurchaseInvoiceLine for the case where that is NOT true. */
export interface InventoryRow {
  handle: string;
  product_id: string;
  photo: string | null;
  /** The stock screens' picture: graded = the baked slab, raw = the bare card. */
  image: string | null;
  /** "PSA 10"; null = raw. */
  grade: string | null;
  name: string;
  sku: string;
  is_card: boolean;
  /** RAW vs GRADED, derived from the card's (or the product metadata's) grader. */
  graded: boolean;
  fmv: number | null;
  price: number | null;
  cost: number | null;
  created_at: string;
  to_procure: number;
  on_hand: number;
  counter: number | null;
  in_vault: number;
  requested: number;
  ready_to_ship: number;
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
 *  whole InventoryRow, so the same three-state `cost` / `counter` rules apply
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

// ── Goods receive notes + procurement (spec 2026-10-28) ──────────────────────

/** open = waiting for its invoice; transferred = an invoice was made from it;
 *  reversed = undone by a reversal GRN; reversal = this GRN IS that undo. */
export type GrnStatus = 'open' | 'transferred' | 'reversed' | 'reversal';

export interface GrnRef {
  id: string;
  display_no: string;
}

/** One row of GET /admin/goods-receive-notes. Totals are folded server-side;
 *  the list carries no lines. A GRN has no cost — only FMV. */
export interface AdminGoodsReceiveNote {
  id: string;
  display_no: string;
  date: string;
  supplier: string;
  agent_user_id: string;
  agent_email: string | null;
  created_at: string;
  status: GrnStatus;
  invoice: GrnRef | null;
  reversed_by: GrnRef | null;
  reverses: GrnRef | null;
  total_qty: number;
  total_fmv: number;
}

/** `fmv_snapshot` is a bigNumber column the route spreads from the ORM row, so
 *  it may arrive as a numeric string — Number() it before any arithmetic, the
 *  same rule as AdminPurchaseInvoiceLine. `qty` is signed (negative on a
 *  reversal GRN). */
export interface AdminGoodsReceiveNoteLine {
  id: string;
  grn_id: string;
  card_handle: string;
  card_name: string;
  fmv_snapshot: number | string;
  qty: number;
}

export interface AdminGoodsReceiveNoteDetail extends AdminGoodsReceiveNote {
  lines: AdminGoodsReceiveNoteLine[];
}

export interface GoodsReceiveNotesPage {
  total: number;
  offset: number;
  limit: number;
  goods_receive_notes: AdminGoodsReceiveNote[];
}

// Same `sort` / `q` contract as listPurchaseInvoices. `status: 'open'` keeps
// only GRNs still waiting for their invoice (the invoice form's picker); the
// route allows no other value.
export const listGoodsReceiveNotes = (
  page = 0,
  q?: string,
  limit = 50,
  sort = 'created_at:desc',
  status?: 'open',
) =>
  getJson<GoodsReceiveNotesPage>(
    `/admin/goods-receive-notes?limit=${limit}&offset=${page * limit}&sort=${encodeURIComponent(sort)}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`,
  );

export const getGoodsReceiveNote = (id: string) =>
  getJson<{ goods_receive_note: AdminGoodsReceiveNoteDetail }>(
    `/admin/goods-receive-notes/${encodeURIComponent(id)}`,
  );

export interface CreateGoodsReceiveNoteBody {
  date: string;
  supplier: string;
  /** qty is a whole number above 0; fmv_snapshot is MYR, at most 2dp. */
  lines: Omit<CreatePurchaseInvoiceLineBody, 'unit_cost'>[];
}

// The workflow returns the bare record, not the list's described row — only
// the id is read from it.
export const createGoodsReceiveNote = (body: CreateGoodsReceiveNoteBody) =>
  postJson<{ goods_receive_note: GrnRef }>('/admin/goods-receive-notes', body);

// Only an OPEN GRN can be reversed; anything else is a 400 with a readable
// message, which the mutation toasts.
export const reverseGoodsReceiveNote = (id: string) =>
  postJson<{ goods_receive_note: GrnRef }>(
    `/admin/goods-receive-notes/${encodeURIComponent(id)}/reverse`,
    {},
  );

/** One card on the purchasing list: to_procure >= 1, oldest waiting order
 *  first (the route sorts). image: graded = the baked slab, raw = the bare
 *  card. fmv_usd = the PriceCharting price as is; fmv = that in MYR at the
 *  live rate, no listing markup. */
export interface ProcurementToBuyRow {
  handle: string;
  name: string;
  sku: string;
  photo: string | null;
  image: string | null;
  graded: boolean;
  /** "PSA 10"; null = raw. */
  grade: string | null;
  to_procure: number;
  on_hand: number;
  requested: number;
  ready_to_ship: number;
  fmv: number | null;
  fmv_usd: number | null;
  oldest_order_at: string | null;
}

// taken_at: when the 12am stock run froze the list; null = live (the run is
// off, or has not run since the last 12am).
export const getProcurementToBuy = () =>
  getJson<{ rows: ProcurementToBuyRow[]; taken_at: string | null }>(
    '/admin/procurement/to-buy',
  );

// The list on screen as a .xlsx with each card's picture in its row. Same
// blob-URL dance as exportInventoryXlsx, for the reasons noted there. The date
// is Malaysia's: the list turns over at 12am MYT, which is still yesterday in
// UTC for the first eight hours.
export async function exportProcurementToBuyXlsx(): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/procurement/to-buy/export`,
    {
      credentials: 'include',
    },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `procurement-to-buy-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// The mailing list: every ready_to_ship order, oldest first, in the Orders
// page's own serialized shape (customer_email included).
export const getProcurementToShip = () =>
  getJson<{ orders: AdminDeliveryOrder[] }>('/admin/procurement/to-ship');

// ── Referral rebuild (spec 2026-08-24) ───────────────────────────────────────

export interface ReferralTierWire {
  min_cents: number;
  rate_bp: number;
}

export interface ReferralSettings {
  tiers: ReferralTierWire[];
  partner_min_bp: number;
  partner_max_bp: number;
}

export async function getReferralSettings(): Promise<ReferralSettings> {
  return getJson<ReferralSettings>('/admin/referrals/settings');
}

export async function updateReferralSettings(input: {
  tiers?: ReferralTierWire[];
  partner_min_bp?: number;
  partner_max_bp?: number;
  reason: string;
}): Promise<ReferralSettings> {
  return postJson<ReferralSettings>('/admin/referrals/settings', input);
}

export interface ReferralSettlement {
  id: string;
  week_start: string;
  status: 'draft' | 'approved' | 'paid' | 'void';
  approved_by: string | null;
  approved_at: string | null;
  paid_at: string | null;
  total_commission_cents: number;
  /** A draft the hourly auto-approval skips: a pending line is over its limit,
   *  so an admin must approve it. */
  held_for_review: boolean;
}

/** Who a settlement line is about; every field but id is null for a
 *  customer whose record is gone. */
export interface ReferralPerson {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface ReferralSettlementLine {
  id: string;
  customer_id: string;
  /** The referrer this line pays — the wallet the commission lands in. */
  customer: ReferralPerson;
  basis_cents: number;
  rate_bp: number;
  amount_cents: number;
  status: 'pending' | 'voided' | 'paid';
  void_reason: string | null;
  paid_transaction_id: string | null;
  /** Downline spend that week, biggest first. Read with live attribution,
   *  so it can differ from basis_cents after an admin re-attribution. */
  downline: { customer: ReferralPerson; spend_cents: number }[];
}

export async function listReferralSettlements(): Promise<ReferralSettlement[]> {
  const data = await getJson<{ settlements: ReferralSettlement[] }>(
    '/admin/referrals/settlements',
  );
  return data.settlements;
}

export async function getReferralSettlement(id: string): Promise<{
  settlement: ReferralSettlement;
  lines: ReferralSettlementLine[];
}> {
  return getJson(`/admin/referrals/settlements/${id}`);
}

export async function approveReferralSettlement(id: string): Promise<void> {
  await postJson(`/admin/referrals/settlements/${id}/approve`, {});
}

export async function payReferralSettlement(
  id: string,
): Promise<{ paid: number; skipped: number }> {
  return postJson(`/admin/referrals/settlements/${id}/pay`, {});
}

export async function voidReferralSettlement(
  id: string,
  reason: string,
): Promise<void> {
  await postJson(`/admin/referrals/settlements/${id}/void`, { reason });
}

export async function setCustomerReferrer(
  customerId: string,
  referrerId: string | null,
  reason: string,
): Promise<void> {
  await postJson(`/admin/customers/${customerId}/referral`, {
    referrer_id: referrerId,
    reason,
  });
}

export async function voidReferralLine(
  lineId: string,
  reason: string,
): Promise<void> {
  await postJson(`/admin/referrals/lines/${lineId}/void`, { reason });
}

export interface CustomerReferralCard {
  referred_by: string | null;
  /** The referrer's name, else email; null if that customer is gone. */
  referred_by_label?: string | null;
  partner_referral_bp: number | null;
  /** Non-null when the player's group is a partner group: its rate is what
   *  pays them and the manual control below is locked (spec 2026-09-09). */
  partner_group: { id: string; name: string; rate_bp: number } | null;
  /** Direct referrals, uncapped — the downline list stops at 1000. */
  downline_count: number;
  /** The still-open settlement week, live — the same numbers the player's own
   *  /referral page shows. rate_bp is the effective rate (group > manual >
   *  tier); partner says it came from a group or manual rate. */
  week: {
    start: string;
    turnover_cents: number;
    rate_bp: number;
    projected_cents: number;
    partner: boolean;
  };
  /** What can stop a week's line paying on Wednesday: over
   *  auto_approve_max_cents the run waits for an admin; over
   *  line_ceiling_cents the close voids the line. */
  payout_limits: {
    auto_approve_max_cents: number;
    line_ceiling_cents: number;
  };
  /** Spend is commission spend: the normal (non-bonus) part of pack opens,
   *  net of reversals — the Players list's "total spend" rule. name/email are
   *  null for a customer whose record is gone. */
  downline: {
    customer_id: string;
    since: string;
    name: string | null;
    email: string | null;
    week_spend_cents: number;
    lifetime_spend_cents: number;
  }[];
  lines: {
    id: string;
    settlement_id: string;
    /** MYT Tuesday the line's week starts, 'YYYY-MM-DD'. */
    week_start: string | null;
    basis_cents: number;
    rate_bp: number;
    amount_cents: number;
    status: string;
  }[];
}

export async function getCustomerReferral(
  customerId: string,
): Promise<CustomerReferralCard> {
  return getJson(`/admin/customers/${customerId}/referral`);
}

// Customer-service corrections (spec 2026-10-06): the customer can set a real
// name once and can never change a verified phone, so these two are the way
// either one moves. Both require an audited reason.
export const setCustomerRealName = (
  customerId: string,
  realName: string,
  reason: string,
) =>
  postJson<{ real_name: string }>(
    `/admin/customers/${encodeURIComponent(customerId)}/real-name`,
    { real_name: realName, reason },
  );

// `new_phone`, not `phone`: the generic admin customer guard refuses a `phone`
// key on every /admin/customers/* POST (rejectAdminPhoneWrite).
export const setCustomerPhone = (
  customerId: string,
  phone: string,
  reason: string,
) =>
  postJson<{ customer: { id: string; phone: string } }>(
    `/admin/customers/${encodeURIComponent(customerId)}/phone`,
    { new_phone: phone, reason },
  );

export async function setPartnerRate(
  customerId: string,
  rateBp: number | null,
  reason: string,
): Promise<void> {
  await postJson(`/admin/customers/${customerId}/partner-rate`, {
    rate_bp: rateBp,
    reason,
  });
}

// ── Task system (spec 2026-08-24 Phase B) ────────────────────────────────────

export interface AdminTaskDefinition {
  id: string;
  kind: 'daily' | 'weekly' | 'achievement';
  title: string;
  requirement: Record<string, unknown>;
  reward: Record<string, unknown>;
  active: boolean;
  sort: number;
  /** Lucky Draw tickets a claim also pays (0 = none). */
  tickets: number;
  /** Optional run window (ISO). null/null = runs until retired. */
  starts_at: string | null;
  ends_at: string | null;
  /** Plain-English summaries resolved server-side (names, not slugs/ids), so
   *  the console never has to load the pack / card / pixel catalogs to render
   *  a row. A dangling reference reads "… (missing)".
   *
   *  OPTIONAL on purpose: a backend that predates this field is a normal
   *  mid-deploy state, and typing it as required is what let the console crash
   *  on `undefined.requirement` instead of degrading. */
  labels?: { requirement: string; reward: string };
}

export async function listTaskDefinitions(): Promise<AdminTaskDefinition[]> {
  const data = await getJson<{ tasks: AdminTaskDefinition[] }>('/admin/tasks');
  return data.tasks;
}

export async function saveTaskDefinition(input: {
  id?: string;
  kind: AdminTaskDefinition['kind'];
  title: string;
  requirement: Record<string, unknown>;
  reward: Record<string, unknown>;
  active: boolean;
  sort: number;
  /** Always sent: the backend keeps a stored value only when this is omitted. */
  tickets: number;
  starts_at: string | null;
  ends_at: string | null;
  reason: string;
}): Promise<{ id: string }> {
  return postJson<{ id: string }>('/admin/tasks', input);
}

// ── Lucky Draw (spec 2026-10-24) ─────────────────────────────────────────────
// Mirrors AdminLuckyDrawEvent / AdminLuckyDrawPrize in the backend's packs
// service. An undrawn prize has no seed anywhere in these shapes — only its
// public `seed_hash`; `result.seed` exists once the draw has run.

export interface AdminLuckyDrawPrize {
  id: string;
  kind: 'card' | 'credit';
  card_handle: string | null;
  credit_myr: number | null;
  title: string;
  image_url: string | null;
  sort: number;
  /** ISO. */
  draw_at: string;
  cancelled_at: string | null;
  seed_hash: string | null;
  total_tickets: number;
  entrant_count: number;
  /** RM: the credit amount, or a card's current value (null if the card is gone). */
  value_myr: number | null;
  result: {
    winner_customer_id: string | null;
    winner_tickets: number;
    total_tickets: number;
    entrant_count: number;
    drawn_at: string;
    seed: string;
    /** false only when a winner exists and nothing was minted / credited. */
    granted: boolean;
  } | null;
}

export interface AdminLuckyDrawEvent {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: 'draft' | 'published' | 'cancelled';
  /** one_winner: one customer wins every prize at the end. per_prize: the old
   *  rules, each prize drawn on its own. A draft becomes one_winner on publish. */
  draw_mode: 'per_prize' | 'one_winner';
  /** The event's own commitment. null until published, and on a per_prize
   *  event, whose hashes are per prize. */
  seed_hash: string | null;
  total_tickets: number;
  entrant_count: number;
  prizes: AdminLuckyDrawPrize[];
}

export interface AdminLuckyDrawEventInput {
  id?: string;
  name: string;
  starts_at: string;
  ends_at: string;
  /** A NEW event only (an edit with prizes is refused): its whole prize pool,
   *  created with it in one transaction. */
  prizes?: AdminLuckyDrawNewPrize[];
}

/** One prize as POST /admin/lucky-draw/prizes takes it (plus `reason`). Send
 *  every field: an omitted sort resets to 0 and an omitted image to null. */
export interface AdminLuckyDrawPrizeInput {
  id?: string;
  event_id: string;
  kind: 'card' | 'credit';
  card_handle: string | null;
  credit_myr: number | null;
  title: string;
  image_url: string | null;
  sort: number;
  /** null = the event's end on create, the stored time on edit. */
  draw_at: string | null;
}

/** One prize of a new event: the prize route's fields without the ids (the
 *  event does not exist yet). Send every field. */
export type AdminLuckyDrawNewPrize = Omit<
  AdminLuckyDrawPrizeInput,
  'id' | 'event_id'
>;

export async function listLuckyDraw(): Promise<AdminLuckyDrawEvent[]> {
  const data = await getJson<{ events: AdminLuckyDrawEvent[] }>(
    '/admin/lucky-draw',
  );
  return data.events;
}

export const saveLuckyDrawEvent = (
  input: AdminLuckyDrawEventInput & { reason: string },
) =>
  postJson<{ id: string; prize_ids: string[] }>(
    '/admin/lucky-draw/events',
    input,
  );

export const publishLuckyDrawEvent = (id: string, reason: string) =>
  postJson<{ id: string; status: 'published' }>(
    `/admin/lucky-draw/events/${encodeURIComponent(id)}/publish`,
    { reason },
  );

/** Cancels a one-winner event and refunds every entrant. Refused once a result
 *  exists. */
export const withdrawLuckyDrawEvent = (id: string, reason: string) =>
  postJson<{ refunded: number }>(
    `/admin/lucky-draw/events/${encodeURIComponent(id)}/withdraw`,
    { reason },
  );

export const saveLuckyDrawPrize = (
  input: AdminLuckyDrawPrizeInput & { reason: string },
) => postJson<{ id: string }>('/admin/lucky-draw/prizes', input);

export const cancelLuckyDrawPrize = (id: string, reason: string) =>
  postJson<{ refunded: number }>(
    `/admin/lucky-draw/prizes/${encodeURIComponent(id)}/cancel`,
    { reason },
  );

export interface AdminLuckyDrawEntrant {
  customer_id: string;
  tickets: number;
}

export async function listLuckyDrawEntries(
  prizeId: string,
): Promise<AdminLuckyDrawEntrant[]> {
  const data = await getJson<{ entries: AdminLuckyDrawEntrant[] }>(
    `/admin/lucky-draw/prizes/${encodeURIComponent(prizeId)}/entries`,
  );
  return data.entries;
}

export async function listLuckyDrawEventEntrants(
  eventId: string,
): Promise<AdminLuckyDrawEntrant[]> {
  const data = await getJson<{ entries: AdminLuckyDrawEntrant[] }>(
    `/admin/lucky-draw/events/${encodeURIComponent(eventId)}/entrants`,
  );
  return data.entries;
}

// ── Ticket pack prizes (spec 2026-10-30 Lucky Pack §2) ──────────────────────

/** A saved row, in the storage units of `pack_odds` (1,000,000 = 100%). */
export interface AdminTicketPrize {
  tickets: number;
  rarity: string;
  weight: number;
  /** null = this amount inherits the previous set. */
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
}

/** A row to save, with win % in the units POST /admin/packs/:slug/odds takes.
 *  The server balances it with the same @acme/odds-math. */
export interface AdminTicketPrizeEntry {
  tickets: number;
  rarity: string;
  locked: boolean;
  pct: number;
  /** null = inherit the previous set. */
  pct_2: number | null;
  pct_3: number | null;
}

const ticketPrizesPath = (slug: string) =>
  `/admin/packs/${encodeURIComponent(slug)}/ticket-prizes`;

export const getTicketPrizes = (slug: string) =>
  getJson<{ rows: AdminTicketPrize[] }>(ticketPrizesPath(slug));

/** Replaces the pack's whole table: a row left out is removed. */
export const saveTicketPrizes = (slug: string, rows: AdminTicketPrizeEntry[]) =>
  postJson<unknown>(ticketPrizesPath(slug), { rows });

export interface AdminLuckyDrawTicketHistory {
  balance: number;
  /** Newest first (the backend caps it at 200). */
  rows: { delta: number; reason: string; ref: string; created_at: string }[];
}

export const getLuckyDrawTickets = (customerId: string) =>
  getJson<AdminLuckyDrawTicketHistory>(
    `/admin/lucky-draw/tickets?customer_id=${encodeURIComponent(customerId)}`,
  );

/** Give (positive) or take back (negative) a customer's Lucky Draw tickets.
 *  The same idempotency key replays instead of granting twice. */
export async function adjustCustomerTickets(
  id: string,
  tickets: number,
  note: string,
  idempotencyKey?: string,
): Promise<{ tickets: number; balance: number }> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/customers/${encodeURIComponent(id)}/lucky-draw-tickets`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickets, note, idempotency_key: idempotencyKey }),
    },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
  return (await res.json()) as { tickets: number; balance: number };
}

// ── Announcement popup (spec 2026-10-06 §5) ──────────────────────────────────

export interface AdminAnnouncement {
  id: string;
  image_url: string;
  title: string | null;
  link_url: string | null;
  active: boolean;
  sort: number;
  /** Optional run window (ISO). null/null = live until switched off. */
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string | null;
}

export async function listAnnouncements(): Promise<AdminAnnouncement[]> {
  const data = await getJson<{ announcements: AdminAnnouncement[] }>(
    '/admin/announcements',
  );
  return data.announcements;
}

export async function saveAnnouncement(input: {
  id?: string;
  image_url: string;
  title: string | null;
  link_url: string | null;
  active: boolean;
  sort: number;
  starts_at: string | null;
  ends_at: string | null;
  reason: string;
}): Promise<{ id: string }> {
  return postJson<{ id: string }>('/admin/announcements', input);
}

// DELETE with a JSON body: the audit reason rides there (the other DELETE
// helpers above send no body, hence no Content-Type).
export async function deleteAnnouncement(
  id: string,
  reason: string,
): Promise<void> {
  const res = await fetch(
    `${__BACKEND_URL__}/admin/announcements/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) {
    throw await httpError(res);
  }
}
