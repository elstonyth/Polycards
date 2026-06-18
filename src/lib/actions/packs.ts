'use server';

/**
 * Open-pack server action. Called from the client pack detail (the "Open Pack"
 * button). Runs server-side so the customer JWT stays in the httpOnly cookie and
 * the backend call isn't CORS-blocked (AUTH/STORE CORS don't list :4000).
 *
 * The backend derives the customer id from the bearer token alone — this action
 * never sends an id — so a pull can't be forged for another account. The route
 * is POST /store/packs/:slug/open (customer-authenticated).
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { formatValue } from '@/lib/packs-format';
import type { Rarity } from '@/app/claw/packs-data';
import { friendlyError, type ErrorRule } from '@/lib/errors';
import { parseOne, WonCardSchema, OpenBuybackSchema } from '@/lib/data/schemas';

// The won card, shaped for the roulette reveal (same fields as a mock PackCard).
export type WonCard = {
  id: string;
  name: string;
  image: string;
  value: string;
  rarity: Rarity;
};

export type OpenPackResult =
  | {
      ok: true;
      card: WonCard;
      /** Ledger id of this pull — keys the instant sell-back; null only if the
       *  backend response shape regresses. */
      pullId: string | null;
      /** Raw USD FMV (decimal) — kept for the reveal's display fallback. */
      marketValue: number;
      /** Authoritative instant sell-back offer for THIS pull, quoted by the
       *  backend from the SAME helper the buyback credits with — so the reveal's
       *  number always matches what selling pays. Null only if an older backend
       *  omitted it (the reveal then falls back to the catalog rate). */
      buyback: {
        percent: number;
        amount: number;
        /** Flat vault rate/amount for the post-expiry sell; null if an older
         *  backend omitted them. */
        vaultPercent: number | null;
        vaultAmount: number | null;
        /** Fallback instant deadline (epoch ms) when the reveal ping fails. */
        instantDeadlineMs: number | null;
      } | null;
      /** Credit balance AFTER the charge (opens debit the pack price — A2);
       *  null only if the backend response shape regresses. */
      balance: number | null;
      /** Pack price debited for this open (USD decimal). Already in the HTTP
       *  response; surfaced for the slot's COST display. Null if it regresses. */
      price: number | null;
    }
  | { ok: false; error: string; needsAuth?: boolean; needsTopUp?: boolean };

// Shape of the `card` returned by the open route (normalized server-side).
interface BackendWonCard {
  handle: string;
  name: string;
  image: string;
  market_value: number;
  rarity: string;
}

// Shape of the `buyback` offer returned by the open route.
interface BackendBuyback {
  percent?: unknown;
  amount?: unknown;
  vault_percent?: unknown;
  vault_amount?: unknown;
  instant_deadline_ms?: unknown;
}

// Patterns local to the open-pack action; never surface raw errors.
const PACKS_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    "You're opening packs too fast — give it a moment and try again.",
  ],
  [/unauthorized|not authenticated|401/i, 'Please log in to open a pack.'],
  [/not enough credits/i, 'Not enough credits to open this pack.'],
  [/not available|not found|404/i, "This pack isn't available right now."],
];
const PACKS_FALLBACK = 'Could not open the pack. Please try again.';

export async function openPack(slug: string): Promise<OpenPackResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { ok: false, error: 'Invalid pack.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to open a pack.',
      needsAuth: true,
    };
  }

  try {
    const { pull, card, balance, price, buyback } = await sdk.client.fetch<{
      pull?: { id?: unknown };
      card: BackendWonCard;
      balance?: unknown;
      price?: unknown;
      buyback?: BackendBuyback;
    }>(`/store/packs/${encodeURIComponent(slug)}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });

    // The fetch generic is a type assertion, not a runtime guard — validate the
    // shape so a renamed field can't render "$NaN" / an undefined rarity ring.
    const wonCard = parseOne(WonCardSchema, card);
    if (!wonCard) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    const offer = parseOne(OpenBuybackSchema, buyback);

    return {
      ok: true,
      card: {
        id: wonCard.handle,
        name: wonCard.name,
        image: card.image,
        value: formatValue(wonCard.market_value),
        rarity: wonCard.rarity as Rarity,
      },
      pullId: typeof pull?.id === 'string' ? pull.id : null,
      marketValue: wonCard.market_value,
      buyback: offer
        ? {
            percent: offer.percent,
            amount: offer.amount,
            vaultPercent: offer.vault_percent ?? null,
            vaultAmount: offer.vault_amount ?? null,
            instantDeadlineMs: offer.instant_deadline_ms ?? null,
          }
        : null,
      balance:
        typeof balance === 'number' && Number.isFinite(balance)
          ? balance
          : null,
      price: typeof price === 'number' && Number.isFinite(price) ? price : null,
    };
  } catch (error) {
    logger.error(`[packs] open-pack failed for '${slug}':`, error);
    const text = error instanceof Error ? error.message : String(error);
    const needsAuth = /unauthorized|401/i.test(text);
    const needsTopUp = /not enough credits/i.test(text);
    return {
      ok: false,
      error: friendlyError(error, PACKS_RULES, PACKS_FALLBACK),
      needsAuth,
      needsTopUp,
    };
  }
}

export type RevealResult =
  | { ok: true; instantDeadlineMs: number }
  | { ok: false };

// Reveal ping — stamps revealed_at server-side so the 30s instant window counts
// from when the card is shown. Best-effort: any failure returns { ok: false }
// and the overlay falls back to the open response's deadline. The backend
// derives the customer from the bearer token; ownership is enforced there.
export async function revealPull(pullId: string): Promise<RevealResult> {
  if (typeof pullId !== 'string' || pullId.trim() === '') return { ok: false };
  const token = await getAuthToken();
  if (!token) return { ok: false };
  try {
    const data = await sdk.client.fetch<{ instant_deadline_ms?: unknown }>(
      `/store/pulls/${encodeURIComponent(pullId)}/reveal`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      },
    );
    const ms = data?.instant_deadline_ms;
    return typeof ms === 'number' && Number.isFinite(ms)
      ? { ok: true, instantDeadlineMs: ms }
      : { ok: false };
  } catch (error) {
    logger.error(`[packs] reveal ping failed for '${pullId}':`, error);
    return { ok: false };
  }
}
