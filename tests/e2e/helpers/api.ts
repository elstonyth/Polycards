// Thin backend client for the parts of the flow we drive directly (auth, credits,
// odds, opens). The storefront's "Open Pack" button is just a server action over
// POST /store/packs/{slug}/open, so opening via this client exercises the exact
// same code path the UI does — just without the slow reveal animation.
import { BACKEND, PK, ADMIN_EMAIL, ADMIN_PASSWORD, stamp } from './constants';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Auth and pack-open endpoints are rate-limited (429 + "Try again in Ns"). Honor
// the hint and retry so a multi-customer / multi-open suite paces itself.
export async function api<T>(
  path: string,
  opts: {
    method?: Method;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-publishable-api-key': PK,
    ...opts.headers,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BACKEND}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    if (res.status === 429 && attempt < 5) {
      const secs = Number(text.match(/again in (\d+)s/)?.[1] ?? '8');
      await sleep((secs + 1) * 1000);
      continue;
    }
    throw new Error(`${opts.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  }
  throw new Error(`${opts.method ?? 'GET'} ${path} -> still rate-limited`);
}

export async function adminToken(): Promise<string> {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      "PW_ADMIN_PASSWORD is not set — export it to match your stack's seeded admin (see tests/e2e/README.md).",
    );
  }
  const r = await api<{ token: string }>('/auth/user/emailpass', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  return r.token;
}

export interface CustomerCreds {
  email: string;
  password: string;
  token: string;
}

// Register → create customer (Bearer register token) → login, mirroring
// src/lib/actions/auth.ts. Optionally top the customer up so they can open packs.
export async function createCustomer(fundUsd = 0): Promise<CustomerCreds> {
  const email = `pw-e2e-${stamp()}@pokenic.local`;
  const password = 'PwE2e2026!';
  const reg = await api<{ token: string }>(
    '/auth/customer/emailpass/register',
    { method: 'POST', body: { email, password } },
  );
  await api('/store/customers', {
    method: 'POST',
    token: reg.token,
    body: { email, first_name: 'PW' },
  });
  const login = await api<{ token: string }>('/auth/customer/emailpass', {
    method: 'POST',
    body: { email, password },
  });
  const creds: CustomerCreds = { email, password, token: login.token };
  if (fundUsd > 0) await topup(creds.token, fundUsd);
  return creds;
}

export async function topup(token: string, amount: number): Promise<number> {
  const r = await api<{ balance: number }>('/store/credits/topup', {
    method: 'POST',
    token,
    body: { amount },
    // Idempotency-Key is MANDATORY since the 2026-07-07 audit (a keyless
    // request 400s before touching the gateway) — mint a fresh one per call.
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  return r.balance;
}

export interface OpenResult {
  card: { handle: string; name: string; rarity: string; market_value: number };
  balance: number;
  price: number;
}

// Open is rate-limited; api() already retries on 429.
export const openPack = (token: string, slug: string): Promise<OpenResult> =>
  api<OpenResult>(`/store/packs/${slug}/open`, {
    method: 'POST',
    token,
    body: {},
  });

export interface OddsRow {
  card_id: string;
  name: string;
  rarity: string;
  market_value: number;
  stock: number | null;
  pct: number;
  locked: boolean;
}

export interface OddsState {
  pack: { title: string; status: string };
  odds: OddsRow[];
}

export const getOdds = (token: string, slug: string): Promise<OddsState> =>
  api<OddsState>(`/admin/packs/${slug}/odds`, { token });

type OddsEntry = Pick<OddsRow, 'card_id' | 'locked' | 'pct' | 'rarity'>;

export const setOdds = (
  token: string,
  slug: string,
  entries: OddsEntry[],
): Promise<OddsState> =>
  api<OddsState>(`/admin/packs/${slug}/odds`, {
    method: 'POST',
    token,
    body: { entries },
  });

export const setMembers = (
  token: string,
  slug: string,
  cardIds: string[],
): Promise<unknown> =>
  api(`/admin/packs/${slug}/members`, {
    method: 'POST',
    token,
    body: { card_ids: cardIds },
  });

export interface EligibleProduct {
  id: string;
  title: string;
  handle: string;
}

export const eligibleProducts = (
  token: string,
): Promise<{ products: EligibleProduct[] }> =>
  api<{ products: EligibleProduct[] }>('/admin/gacha/eligible-products', {
    token,
  });

export interface AdminCard {
  handle: string;
  name: string;
  /** Raw USD FMV (PriceCharting-native). Operators enter RM in the admin UI;
   *  it is stored as USD (RM ÷ fx) — see priceBreakdown for the RM figures. */
  market_value: number;
  for_sale: boolean;
  priceBreakdown?: {
    raw: number;
    fxRate: number;
    /** market_value × fx — the RM figure the admin FMV field round-trips. */
    marketMyr: number;
    /** marketMyr × the card's own multiplier — what the storefront displays. */
    displayPrice: number;
    markup: number;
  };
}

export const listCards = (token: string): Promise<{ cards: AdminCard[] }> =>
  api<{ cards: AdminCard[] }>('/admin/cards', { token });

export async function deleteCardIfExists(
  token: string,
  handle: string,
): Promise<void> {
  try {
    await api(`/admin/cards/${handle}`, { method: 'DELETE', token });
  } catch {
    /* 404 = already gone */
  }
}

// Snapshot the current odds as a restorable entry list.
export const snapshotOdds = (odds: OddsRow[]): OddsEntry[] =>
  odds.map((o) => ({
    card_id: o.card_id,
    locked: o.locked,
    pct: o.pct,
    rarity: o.rarity,
  }));

// ---- delivery (ship-orders flow) -------------------------------------------
// An API pack-open auto-vaults the pull (GET /store/vault then lists it), so the
// ship test sets up a real 'requested' delivery order entirely over HTTP for
// determinism, then drives the admin Deliveries UI to mark it shipped.

interface VaultItem {
  pull_id: string;
}

// First vaulted pull id for the customer (open one pack first).
export async function firstVaultPullId(token: string): Promise<string> {
  const { items } = await api<{ items: VaultItem[] }>('/store/vault', {
    token,
  });
  const id = items[0]?.pull_id;
  if (!id)
    throw new Error('vault empty — open a pack before requesting delivery');
  return id;
}

// Add a shipping address to the customer's address book; returns its id. Matches
// on the (unique-per-run) address line so reruns never grab a stale address.
export async function createAddress(
  token: string,
  addressLine: string,
): Promise<string> {
  const { customer } = await api<{
    customer: { addresses: Array<{ id: string; address_1: string }> };
  }>('/store/customers/me/addresses', {
    method: 'POST',
    token,
    body: {
      first_name: 'Ash',
      last_name: 'Ketchum',
      address_1: addressLine,
      city: 'Kuala Lumpur',
      postal_code: '50000',
      country_code: 'my',
    },
  });
  const created = customer.addresses.find((a) => a.address_1 === addressLine);
  if (!created) throw new Error('address was not created');
  return created.id;
}

// Request physical delivery of vaulted pulls; returns the delivery order id.
export async function requestDelivery(
  token: string,
  pullIds: string[],
  addressId: string,
): Promise<string> {
  const { order_id } = await api<{ order_id: string }>(
    '/store/delivery-orders',
    {
      method: 'POST',
      token,
      body: { pull_ids: pullIds, address_id: addressId },
    },
  );
  return order_id;
}

export interface AdminDeliveryOrder {
  id: string;
  status: string;
  tracking_number: string | null;
}

// Admin read of a single delivery order (ground truth for the ship assertion).
export async function adminGetDeliveryOrder(
  token: string,
  id: string,
): Promise<AdminDeliveryOrder> {
  const { order } = await api<{ order: AdminDeliveryOrder }>(
    `/admin/delivery-orders/${id}`,
    { token },
  );
  return order;
}
