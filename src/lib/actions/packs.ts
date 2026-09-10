'use server';

/**
 * Open-pack server action. Called from the client pack detail (the "Open Pack"
 * button). Runs server-side so the customer JWT stays in the httpOnly cookie and
 * the backend call isn't CORS-blocked (AUTH/STORE CORS don't list :4000).
 *
 * The backend derives the customer id from the bearer token alone — this action
 * never sends an id — so a pull can't be forged for another account. The route
 * is POST /store/packs/:slug/open (customer-authenticated).
 *
 * Every call goes through the `Store` port (src/lib/store.ts), which owns the
 * cookie read, the bearer and the failure log — but NOT the envelope check.
 * Responses use `UncheckedSchema`: card validation retains the special
 * Vault copy below. Local projection catches retain the pre-port fallback
 * for malformed JSON envelopes/rows; JSON parsing alone cannot reject those.
 */
import { store, type Failure } from '@/lib/store';
import { logger } from '@/lib/logger';
import type { PackCard } from '@/lib/packs-data';
import {
  friendlyFailure,
  RATE_LIMITED,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import { parseOne, UncheckedSchema, WonCardSchema } from '@/lib/data/schemas';
import { toCardView } from '@/lib/card-view';
import { mapBatchRoll, clampCount, toBuybackOffer } from './pack-batch-map';
import type { RawBatchRollItem, BatchRoll } from './pack-batch-map';
export type { BatchRoll, BuybackOffer } from './pack-batch-map';

/** The won card, shaped for the reveal — the same view as a pool card, so a
 *  demo draw and a real open hand the machine one shape. `priceMyr` is the
 *  live MYR display price (raw USD FMV × FX × per-card multiplier), the same
 *  number the vault shows; null if an older/un-enriched backend omitted it —
 *  the reveal then renders '—', never "RM 0.00". */
export type WonCard = PackCard;

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
        /** false = quoted on the FX display fallback; selling would be
         *  refused, so the reveal must not present this as a firm offer. */
        firm: boolean;
      } | null;
      /** Credit balance AFTER the charge (opens debit the pack price — A2);
       *  null only if the backend response shape regresses. */
      balance: number | null;
      /** Pack price debited for this open (RM decimal). Already in the HTTP
       *  response; surfaced for the slot's COST display. Null if it regresses. */
      price: number | null;
      /** True when this was the one-time FREE welcome open — read from the
       *  backend's `free` flag (which it reads off the recorded pull), never
       *  inferred from `price === 0`, which a future promo pack could also be.
       *  Badge/copy only: the SELL lock rides on `locked`. Defaults false so an
       *  older backend can only ever under-claim. */
      free: boolean;
      /** True when this pull cannot be sold or delivered yet — the free welcome
       *  pull before the account's first PAID open. NOT the same as `free`: a
       *  free pack claimed AFTER a paid open is already unlocked and sellable,
       *  and suppressing its sell UI would hide a real offer. */
      locked: boolean;
    }
  | { ok: false; error: string; needsAuth?: boolean; needsTopUp?: boolean };

const LOGIN_TO_OPEN = 'Please log in to open a pack.';

// Patterns local to the open-pack action; never surface raw errors.
// Both transport rules stay: the probes are the shared ones (lib/errors.ts)
// but the SENTENCES are this surface's own — "opening packs too fast" names
// what the customer was doing, which the shared copy cannot.
const PACKS_RULES: ErrorRule[] = [
  [
    RATE_LIMITED,
    "You're opening packs too fast — give it a moment and try again.",
  ],
  [UNAUTHORIZED, LOGIN_TO_OPEN],
  [/not enough credits/i, 'Not enough credits to open this pack.'],
  // A pack whose prize pool is empty/zero-weight (mid-setup in admin). Must
  // precede the generic not-found rule: the backend throws it as NOT_FOUND.
  [
    /no odds|invalid odds|prize pool/i,
    "This pack isn't ready yet — check back soon.",
  ],
  [/not available|not found|404/i, "This pack isn't available right now."],
];
const PACKS_FALLBACK = 'Could not open the pack. Please try again.';
// Every failure AFTER a 2xx: the open is committed and the pull vaulted, so
// "try again" would invite a second charge (schemas.ts, the unchecked-envelope
// rule). Says where the card went instead.
const CHARGED_BUT_UNSHOWABLE =
  "Your pack opened and the card is in your Vault, but we couldn't show it here.";

/**
 * A port `Failure` in the open actions' vocabulary.
 *
 * No cookie at all (the call never left — `status` is undefined) keeps the
 * logged-out shape these actions have always returned: the login copy and
 * `needsAuth`, with no `needsTopUp` key at all. Anything the backend actually
 * said goes through PACKS_RULES, with `needsAuth` from the port's
 * classification and `needsTopUp` still a prose probe — no status
 * distinguishes "broke" from any other 400 (see the note on friendlyError in
 * lib/errors.ts).
 */
function openFailure(f: Failure): {
  ok: false;
  error: string;
  needsAuth?: boolean;
  needsTopUp?: boolean;
} {
  if (f.kind === 'unauthenticated' && f.status === undefined) {
    return { ok: false, error: LOGIN_TO_OPEN, needsAuth: true };
  }
  return {
    ok: false,
    error: friendlyFailure(f, PACKS_RULES, PACKS_FALLBACK),
    needsAuth: f.kind === 'unauthenticated',
    needsTopUp: /not enough credits/i.test(f.text),
  };
}

export async function openPack(slug: string): Promise<OpenPackResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { ok: false, error: 'Invalid pack.' };
  }

  const r = await store.post(
    `/store/packs/${encodeURIComponent(slug)}/open`,
    UncheckedSchema,
    {},
  );
  if (!r.ok) return openFailure(r);

  // JSON parsing accepts null and malformed nested objects; preserve the
  // pre-port projection fallback without changing the Store contract.
  try {
    const { pull, card, balance, price, buyback, free, locked } = r.data as {
      pull?: { id?: unknown };
      // Untyped on purpose: only ever handed to parseOne(WonCardSchema).
      card?: unknown;
      balance?: unknown;
      price?: unknown;
      // Untyped on purpose: only ever handed to parseOne(OpenBuybackSchema).
      buyback?: unknown;
      free?: unknown;
      locked?: unknown;
    };

    // The envelope is unchecked (see the header) — validate the CARD so a
    // renamed field can't render "$NaN" / an undefined rarity ring.
    const wonCard = parseOne(WonCardSchema, card);
    if (!wonCard) {
      // The open is committed and the pull vaulted by now — never say "try
      // again" over a charged open (a retry would charge twice).
      return {
        ok: false,
        error: CHARGED_BUT_UNSHOWABLE,
      };
    }

    return {
      ok: true,
      // `image` / `slab_image` ride WonCardSchema's looseObject passthrough, so
      // the one mapper reads them off the same validated object (same as the
      // batch and free-rip opens). The tier is re-stated because the schema
      // guarantees it and the reveal's card type requires it.
      card: { ...toCardView(wonCard), rarity: wonCard.rarity },
      pullId: typeof pull?.id === 'string' ? pull.id : null,
      marketValue: wonCard.market_value,
      buyback: toBuybackOffer(buyback),
      balance:
        typeof balance === 'number' && Number.isFinite(balance)
          ? balance
          : null,
      price: typeof price === 'number' && Number.isFinite(price) ? price : null,
      // Only a literal true claims a free open (an older backend omits it).
      free: free === true,
      // A backend that predates `locked` still sends `free` — fall back to it
      // so a free pull reads as locked rather than offering a sell that 400s.
      locked: typeof locked === 'boolean' ? locked : free === true,
    };
  } catch (error) {
    logger.error('[packs] response projection failed:', error);
    // A 2xx got here — the open is committed and the pull vaulted, so this
    // must not say "try again" either.
    return {
      ok: false,
      error: CHARGED_BUT_UNSHOWABLE,
      needsAuth: false,
      needsTopUp: false,
    };
  }
}

export type OpenBatchResult =
  | {
      ok: true;
      rolls: BatchRoll[];
      /** Pack price debited per roll (RM decimal). Null on response regression. */
      price: number | null;
      /** Total charged for the whole batch (`total_charged` from backend). */
      total: number | null;
      /** Credit balance AFTER the batch debit. Null on response regression. */
      balance: number | null;
    }
  | { ok: false; error: string; needsAuth?: boolean; needsTopUp?: boolean };

export async function openBatch(
  slug: string,
  count: number,
): Promise<OpenBatchResult> {
  // Boundary validation.
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { ok: false, error: 'Invalid pack.' };
  }

  // Clamp count to int in [1, 3].
  const clampedCount = clampCount(count);

  const r = await store.post(
    `/store/packs/${encodeURIComponent(slug)}/open-batch`,
    UncheckedSchema,
    { count: clampedCount },
  );
  if (!r.ok) return openFailure(r);

  // JSON parsing accepts null and malformed nested objects; preserve the
  // pre-port projection fallback without changing the Store contract.
  try {
    const {
      rolls: rawRolls,
      balance,
      price,
      total_charged,
    } = r.data as {
      rolls: RawBatchRollItem[];
      balance?: unknown;
      price?: unknown;
      total_charged?: unknown;
    };

    // The envelope is unchecked (see the header), so `rolls` might not be an
    // array at all. Pre-port this was a TypeError — `for (const rawRoll of
    // rawRolls)` over `undefined` — caught by the action's own try/catch and
    // answered with the pre-port SHAPE (both flags false); this guard keeps
    // that shape, but not the pre-port sentence — a 2xx got here, so the
    // charge is committed and "try again" would invite a second one. A
    // non-JSON 200 never reaches here — the adapter turns it into a Failure
    // before `r.data` exists — but a JSON 200 that simply omits `rolls` does,
    // which is what the test below pins. An explicit `rolls: []` is left
    // alone: that is a legal (if odd) 2xx and has always answered ok with no
    // rolls.
    if (!Array.isArray(rawRolls)) {
      logger.error(`[packs] open-batch returned no rolls array for '${slug}'`);
      return {
        ok: false,
        error: CHARGED_BUT_UNSHOWABLE,
        needsAuth: false,
        needsTopUp: false,
      };
    }

    // Validate and map every roll. The charge is committed and every pull is
    // already `vaulted` by the time this runs, so a roll that fails
    // WonCardSchema is DROPPED, not fatal: the customer sees the cards that did
    // map. Only when none map is the batch refused — and the copy then says
    // where the card went, never "try again" (a retry would charge twice).
    const rolls: BatchRoll[] = [];
    for (const rawRoll of rawRolls) {
      const mapped = mapBatchRoll(rawRoll);
      if (mapped) rolls.push(mapped);
      else logger.error(`[packs] open-batch roll failed to map for '${slug}'`);
    }
    if (rolls.length === 0 && rawRolls.length > 0) {
      return {
        ok: false,
        error: CHARGED_BUT_UNSHOWABLE,
      };
    }

    return {
      ok: true,
      rolls,
      balance:
        typeof balance === 'number' && Number.isFinite(balance)
          ? balance
          : null,
      price: typeof price === 'number' && Number.isFinite(price) ? price : null,
      total:
        typeof total_charged === 'number' && Number.isFinite(total_charged)
          ? total_charged
          : null,
    };
  } catch (error) {
    logger.error('[packs] response projection failed:', error);
    // A 2xx got here — the open is committed and every mapped pull is
    // vaulted, so this must not say "try again" either.
    return {
      ok: false,
      error: CHARGED_BUT_UNSHOWABLE,
      needsAuth: false,
      needsTopUp: false,
    };
  }
}

export type RevealResult =
  { ok: true; instantDeadlineMs: number } | { ok: false };

// Reveal ping — stamps revealed_at server-side so the 30s instant window counts
// from when the card is shown. Best-effort: any failure returns { ok: false }
// and the overlay falls back to the open response's deadline. The backend
// derives the customer from the bearer token; ownership is enforced there.
/**
 * End the instant-buyback window for these pulls — called when the reveal
 * concludes or the customer leaves it. From then the vault (and every later
 * sell) quotes the flat rate, even inside the 30s (approach A: close-on-leave;
 * the 30s deadline is only the hard-tab-kill backstop). Fire-and-forget: the
 * backend is owner-scoped and close-only, so a lost or duplicate call is
 * harmless, and the server still enforces the flat rate on any actual sell.
 */
export async function closeInstantWindow(pullIds: string[]): Promise<void> {
  const ids = (pullIds ?? []).filter(
    (x) => typeof x === 'string' && x.trim() !== '',
  );
  if (ids.length === 0) return;
  // Fire-and-forget: the response is not read, and a failure (logged out, a
  // closed window, a network drop) is already logged by the port.
  await store.post('/store/pulls/close-instant', UncheckedSchema, {
    pull_ids: ids,
  });
}

export async function revealPull(pullId: string): Promise<RevealResult> {
  if (typeof pullId !== 'string' || pullId.trim() === '') return { ok: false };
  const r = await store.post(
    `/store/pulls/${encodeURIComponent(pullId)}/reveal`,
    UncheckedSchema,
    {},
  );
  // Best-effort: logged out, a failed ping, or a body without the deadline all
  // fall back to the open response's deadline.
  if (!r.ok) return { ok: false };
  const ms = (r.data as { instant_deadline_ms?: unknown } | null | undefined)
    ?.instant_deadline_ms;
  return typeof ms === 'number' && Number.isFinite(ms)
    ? { ok: true, instantDeadlineMs: ms }
    : { ok: false };
}
