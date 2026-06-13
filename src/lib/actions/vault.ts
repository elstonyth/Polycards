'use server';

/**
 * Vault + credit server actions. Run server-side so the customer JWT stays in
 * the httpOnly cookie and the backend calls aren't CORS-blocked. The backend
 * derives the customer id from the bearer token alone — these actions never
 * send an id — so one customer can never touch another's vault or balance.
 *
 * Backend routes (all customer-authenticated):
 *   GET  /store/vault              — vaulted pulls + live buyback offers
 *   POST /store/vault/:id/buyback  — instant sell-back (credits FMV × pack %)
 *   GET  /store/credits            — balance (Σ ledger) + recent transactions
 *   POST /store/credits/topup      — buy credit via the mock gateway (demo)
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';

export type VaultItem = {
  pullId: string;
  rolledAt: string;
  packId: string;
  packTitle: string;
  card: {
    handle: string;
    name: string;
    image: string;
    rarity: string;
    marketValue: number;
  };
  buyback: {
    percent: number;
    amount: number;
  };
};

export type VaultResult =
  | { ok: true; items: VaultItem[]; balance: number }
  | { ok: false; error: string; needsAuth?: boolean };

export type SellBackResult =
  | { ok: true; amount: number; percent: number; balance: number }
  | { ok: false; error: string; needsAuth?: boolean };

interface BackendVaultItem {
  pull_id: string;
  rolled_at: string;
  pack_id: string;
  pack_title: string;
  card: {
    handle: string;
    name: string;
    image: string;
    rarity: string;
    market_value: number;
  };
  buyback: { percent: number; amount: number };
}

function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/too many|rate.?limit|429/i.test(text))
    return 'Too many requests — give it a moment and try again.';
  if (/unauthorized|not authenticated|401/i.test(text))
    return 'Please log in to view your vault.';
  if (/declined/i.test(text))
    return 'Payment declined by the demo gateway — amounts ending in .13 always decline.';
  if (/amount/i.test(text))
    return 'Enter a valid amount (up to $10,000, whole cents).';
  if (/already sold/i.test(text)) return 'This card was already sold back.';
  if (/not found|404/i.test(text))
    return 'This card is no longer in your vault.';
  return 'Something went wrong. Please try again.';
}

const needsAuthFrom = (error: unknown): boolean =>
  /unauthorized|not authenticated|401/i.test(
    error instanceof Error ? error.message : String(error),
  );

// The vault list + the credit balance in one call (the page shows both).
export async function getVault(): Promise<VaultResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your vault.',
      needsAuth: true,
    };
  }

  try {
    const [{ items }, { balance }] = await Promise.all([
      sdk.client.fetch<{ items: BackendVaultItem[] }>('/store/vault', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
      sdk.client.fetch<{ balance: number }>('/store/credits', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
    ]);

    const safeItems = (Array.isArray(items) ? items : [])
      .filter(
        (i) =>
          i &&
          typeof i.pull_id === 'string' &&
          i.card &&
          typeof i.card.name === 'string' &&
          Number.isFinite(i.buyback?.amount),
      )
      .map((i) => ({
        pullId: i.pull_id,
        rolledAt: i.rolled_at,
        packId: i.pack_id,
        packTitle: i.pack_title,
        card: {
          handle: i.card.handle,
          name: i.card.name,
          image: i.card.image,
          rarity: i.card.rarity,
          marketValue: i.card.market_value,
        },
        buyback: { percent: i.buyback.percent, amount: i.buyback.amount },
      }));

    return {
      ok: true,
      items: safeItems,
      balance: Number.isFinite(balance) ? balance : 0,
    };
  } catch (error) {
    logger.error('[vault] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error),
      needsAuth: needsAuthFrom(error),
    };
  }
}

// The bare credit balance — for surfaces that show affordability (the pack
// detail page) without paying for the full vault read. Null = not logged in
// or the read failed; callers render nothing rather than a wrong $0.
export async function getCreditBalance(): Promise<number | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const { balance } = await sdk.client.fetch<{ balance: number }>(
      '/store/credits',
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    return Number.isFinite(balance) ? balance : null;
  } catch (error) {
    logger.error('[vault] balance read failed:', error);
    return null;
  }
}

export type TopUpActionResult =
  | { ok: true; amount: number; balance: number }
  | { ok: false; error: string; needsAuth?: boolean };

// Buy site credit through the mock gateway (demo — no real payment). The fake
// card fields never leave the browser; only the amount is posted, and the
// backend re-validates it (the gateway declines amounts ending in .13).
export async function topUpCredits(amount: number): Promise<TopUpActionResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter a valid amount.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const res = await sdk.client.fetch<{ amount: number; balance: number }>(
      '/store/credits/topup',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { amount },
      },
    );

    if (!Number.isFinite(res.amount) || !Number.isFinite(res.balance)) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, amount: res.amount, balance: res.balance };
  } catch (error) {
    logger.error('[vault] top-up failed:', error);
    return {
      ok: false,
      error: friendlyError(error),
      needsAuth: needsAuthFrom(error),
    };
  }
}

// Instant sell-back of one vaulted pull. Safe to retry: the backend enforces
// once-per-pull at the database level.
export async function sellBackPull(pullId: string): Promise<SellBackResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof pullId !== 'string' || pullId.trim() === '') {
    return { ok: false, error: 'Invalid card.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const res = await sdk.client.fetch<{
      amount: number;
      percent: number;
      balance: number;
    }>(`/store/vault/${encodeURIComponent(pullId)}/buyback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });

    if (!Number.isFinite(res.amount) || !Number.isFinite(res.balance)) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return {
      ok: true,
      amount: res.amount,
      percent: res.percent,
      balance: res.balance,
    };
  } catch (error) {
    logger.error(`[vault] buyback failed for '${pullId}':`, error);
    return {
      ok: false,
      error: friendlyError(error),
      needsAuth: needsAuthFrom(error),
    };
  }
}
