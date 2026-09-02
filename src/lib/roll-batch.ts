/**
 * One roll batch, whichever route produced it.
 *
 * CONTEXT.md holds three words apart on purpose, and this file is the one place
 * they are allowed to meet:
 *
 *   Open — the PAID, server-side act that spends credit, rolls PackOdds and
 *          writes a Pull. THREE routes reach it: the batch open, the one-time
 *          free welcome pack, and a task's free rip.
 *   Spin — client-side demo theater for a logged-out visitor. Samples the
 *          published odds and shows a card. No Open, no Pull, no credit, no
 *          stock, no server call at all.
 *   Pull — the record of one prize acquisition.
 *
 * The slot machine used to fork on "is this a demo?" at a dozen-odd sites
 * because each of those four routes answered in a DIFFERENT shape and each
 * shape was squeezed into the batch shape inline, at the call site. Here they
 * are adapted once, to one shape — `RolledBatch` — so the component asks which
 * route it is at press time and never again.
 *
 * MONEY-PATH RULES. These are load-bearing, not preferences:
 *
 *   • Exactly ONE server call per `rollBatch()`. No loop, no retry, no second
 *     route on failure. A result that may have debited (`needsTopUp`, or a
 *     throw after the request left) is REPORTED, never re-attempted — the
 *     charge may already have landed and a retry would double it.
 *   • The server actions are INJECTED (`RollDeps`) rather than imported. That
 *     keeps this module clear of the `'use server'` boundary so vitest can run
 *     it, and it is what makes the invariant that matters most assertable: a
 *     demo Spin issues ZERO server calls.
 *   • Every roll — paid, free or demo — goes through the SAME offer builder.
 *     A free rip carries a real `pullId` and therefore a real (flat-rate)
 *     offer: it is `locked`, not offer-less, that suppresses its sell UI.
 *     Special-casing its offer to null would silently kill the sell countdown,
 *     the instant-window close on unmount, and the auto-conclude guard — all
 *     of which key off a non-null offer.
 */
import { demoDraw, type PublishedOdd } from '@/lib/demo-spin';
import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';
import { SELL_COUNTDOWN_SECS } from '@/lib/sell-countdown';
import { logger } from '@/lib/logger';
import type { PackCard } from '@/lib/packs-data';
// Type-only, all of them: `actions/*` are `'use server'` modules and
// `useSellWindow` is `'use client'`. Erased at compile time, so this module
// stays importable from a plain node test (same pattern as pack-batch-map.ts).
import type {
  WonCard,
  OpenBatchResult,
  OpenPackResult,
} from '@/lib/actions/packs';
import type { BuybackOffer } from '@/lib/actions/pack-batch-map';
import type { SpinTaskRewardResult } from '@/lib/actions/tasks';
import type { SellBackOffer } from '@/app/slots/[slug]/useSellWindow';

/** Which of the four routes a press takes. Decided ONCE, by `rollMode`. */
export type RollMode = 'demo' | 'free-rip' | 'free-pack' | 'paid';

/** Shown when a demo pool has nothing to draw from — see `rollBlocker`. */
const EMPTY_DEMO_POOL = 'No cards in this pack yet — check back soon.';
const NO_FREE_RIP_CLAIM =
  'That free rip is no longer available — open the task again.';
const NOTHING_OPENED = 'Nothing was opened — your balance is unchanged.';

/**
 * The route this press takes, in priority order.
 *
 * Demo wins outright and only for a guest: a logged-in customer on `?demo=1`
 * gets the real machine, because the demo exists as a pre-signup taste and
 * never as a mode for players. A guest can therefore never reach a paid or
 * entitlement route from here.
 */
export function rollMode(input: {
  /** Non-null = the page is in `?demo=1` guest mode. */
  demoPool: PackCard[] | null;
  signedIn: boolean;
  /** A task's free-rip entitlement (`?freeRip=<claimId>`). */
  freeRipClaimId: string | null;
  /** `pack.categoryId === FREE_WELCOME_CATEGORY`. */
  freeWelcome: boolean;
}): RollMode {
  if (input.demoPool !== null && !input.signedIn) return 'demo';
  if (input.freeRipClaimId !== null && input.freeRipClaimId !== '') {
    return 'free-rip';
  }
  if (input.freeWelcome) return 'free-pack';
  return 'paid';
}

export interface RollRequest {
  mode: RollMode;
  /** Pack slug — `id` doubles as the route slug for both open routes. */
  packId: string;
  /**
   * Reels requested. Every SINGLE-OPEN mode ignores it and yields exactly one
   * roll: the backend rejects a batch on the free-welcome category outright,
   * and a free rip spends one entitlement. Only `paid` spends it.
   */
  reels: number;
  freeRipClaimId: string | null;
  /** The public pool a demo Spin samples. Empty for every other mode. */
  demoPool: PackCard[];
  /** Odds a demo Spin samples on — the caller resolves the set-3 → published
   *  → static fallback (see `pickDemoOdds`). Ignored by every other mode. */
  demoOdds: PublishedOdd[];
  /** Customer this roll is charged to. Null for a guest demo, which is bound
   *  to no account at all — see `RolledBatch.forId`. */
  forId: string | null;
}

/** The one shape the component sees, whichever route produced it. */
export interface RolledBatch {
  mode: RollMode;
  /**
   * The roll's single timestamp: the reel nonce AND the fallback instant-sell
   * deadline. Read at the same beat the old inline code read `Date.now()` —
   * BEFORE the draw for a demo, AFTER the response for an open — so the
   * fallback sell window never shrinks by a round-trip.
   */
  spinAt: number;
  cards: WonCard[];
  /** Exactly one entry per card; null where the roll carries no sellable
   *  pull. Never a short array — `useSellWindow` seeds per-card state from it. */
  offers: (SellBackOffer | null)[];
  /** Authoritative balance AFTER the charge. Null when nothing was charged
   *  (demo, free rip) or the response shape regressed. */
  balance: number | null;
  /** The server said this pull cannot be sold or delivered yet. Read straight
   *  off the response, never derived from "was it free" — a welcome pack
   *  claimed after a paid open comes back UNLOCKED and keeps its sell button. */
  locked: boolean;
  /** The account this result belongs to; null for a demo. The settle guard
   *  compares it against the account signed in NOW. */
  forId: string | null;
}

export type RollResult =
  | { ok: true; batch: RolledBatch }
  /** The request left but no answer came back. The charge MAY have landed:
   *  the caller must re-read the balance before re-enabling the button, and
   *  must never claim either a free spin or a charge. */
  | { ok: false; kind: 'unreachable' }
  /** The server answered no (or, for the batch route, answered yes with no
   *  rolls). `needsTopUp` still implies a possible debit. */
  | {
      ok: false;
      kind: 'rejected';
      error: string;
      needsAuth?: boolean;
      needsTopUp?: boolean;
    };

/** The seams this module refuses to import. See the header. */
export interface RollDeps {
  openBatch: (slug: string, count: number) => Promise<OpenBatchResult>;
  openPack: (slug: string) => Promise<OpenPackResult>;
  spinTaskReward: (claimId: string) => Promise<SpinTaskRewardResult>;
  /** Injected so `spinAt` is assertable; the caller passes `Date.now`. */
  now: () => number;
  /** Injected so a demo draw is reproducible in a test; `Math.random` in app
   *  code — nothing is at stake in a demo draw. */
  random: () => number;
}

/**
 * Why this press cannot start at all, or null.
 *
 * Checked BEFORE the caller touches any state, so a blocked press leaves the
 * machine exactly as it found it. Server-side refusals are deliberately NOT
 * here: those cost a round-trip and come back from `rollBatch` instead.
 */
export function rollBlocker(req: RollRequest): string | null {
  return req.mode === 'demo' && req.demoPool.length === 0
    ? EMPTY_DEMO_POOL
    : null;
}

/** What every route reduces to before the shared offer builder runs. */
interface NormalizedRoll {
  card: WonCard;
  /** Ledger id of the Pull. Null = nothing sellable — a demo card, or a
   *  response whose shape regressed. */
  pullId: string | null;
  buyback: BuybackOffer | null;
}

/**
 * The sell-back offer for one roll — the ONLY place one is built.
 *
 * A null `pullId` (demo card, regressed response) is the only thing that
 * yields no offer. Everything else gets one, falling back to the flat catalog
 * rate when an older backend quoted nothing.
 */
function buildOffer(
  roll: NormalizedRoll,
  spinAt: number,
): SellBackOffer | null {
  if (roll.pullId === null) return null;
  // MYR display price; marketValue is raw USD FMV and must NEVER render behind
  // "RM" — when an older backend omits marketPriceMyr, fall back to 0 (the
  // vault seam's policy, actions/vault.ts) and let SellConfirmModal show "—"
  // for an unknown value. The offer's amount fallbacks derive from this SAME
  // figure so a single offer can never mix currencies.
  const displayFmv = roll.card.marketPriceMyr ?? 0;
  const flat = Math.round(displayFmv * FLAT_BUYBACK_PERCENT) / 100;
  return {
    pullId: roll.pullId,
    fmv: displayFmv,
    cardName: roll.card.name,
    image: roll.card.image,
    slabImage: roll.card.slab_image,
    percent: roll.buyback?.percent ?? FLAT_BUYBACK_PERCENT,
    amount: roll.buyback?.amount ?? flat,
    vaultPercent: roll.buyback?.vaultPercent ?? FLAT_BUYBACK_PERCENT,
    vaultAmount: roll.buyback?.vaultAmount ?? flat,
    instantDeadlineMs:
      roll.buyback?.instantDeadlineMs ?? spinAt + SELL_COUNTDOWN_SECS * 1000,
    firm: roll.buyback?.firm ?? true,
  };
}

function batchOf(
  req: RollRequest,
  rolls: NormalizedRoll[],
  spinAt: number,
  balance: number | null,
  locked: boolean,
): RolledBatch {
  return {
    mode: req.mode,
    spinAt,
    cards: rolls.map((r) => r.card),
    offers: rolls.map((r) => buildOffer(r, spinAt)),
    balance,
    locked,
    // A demo is bound to no account by construction, so it carries no owner —
    // STRUCTURALLY, not by convention. The caller only ever builds a demo
    // request when signed out (so req.forId is already null), but pinning it
    // here means the settle guard's `forId !== null` test cannot be defeated by
    // a hand-built request, and the two facts can never drift apart.
    forId: req.mode === 'demo' ? null : req.forId,
  };
}

/**
 * Sample the demo batch client-side. Pure theater: no server call, no charge,
 * no Pull row, no stock movement, and every offer comes back null because
 * there is no pull to sell.
 */
function demoSpin(req: RollRequest, deps: RollDeps): RollResult {
  // Impure reads are safe here: the caller is a click handler, never render.
  const spinAt = deps.now();
  const rolls: NormalizedRoll[] = [];
  for (let i = 0; i < req.reels; i++) {
    const drawn = demoDraw(
      req.demoPool,
      req.demoOdds,
      deps.random(),
      deps.random(),
    );
    // Unreachable past `rollBlocker` — an empty pool is demoDraw's only miss.
    if (!drawn) return { ok: false, kind: 'rejected', error: EMPTY_DEMO_POOL };
    rolls.push({
      card: {
        ...drawn,
        slab_image: drawn.slabImage,
        pokemon_dex: null,
        sprite_image: null,
        marketPriceMyr: null,
      },
      pullId: null,
      buyback: null,
    });
  }
  return { ok: true, batch: batchOf(req, rolls, spinAt, null, false) };
}

/**
 * Perform the paid Open — through whichever of the three server routes this
 * mode uses. ONE call, whatever happens; see the header's money-path rules.
 */
async function openRolls(
  req: RollRequest,
  deps: RollDeps,
): Promise<RollResult> {
  try {
    if (req.mode === 'free-rip') {
      // Spends the task entitlement. `already_redeemed` is NOT an error: it
      // means an earlier attempt committed (a retry, a double-tap, a lost
      // response) and the card is already in the vault. Say so, so the reveal
      // is not invented client-side from a roll that did not happen here.
      // Refuse rather than coalesce. rollMode only returns 'free-rip' for a
      // non-empty claim id, so this is unreachable — but `?? ''` would turn an
      // impossible state into a SERVER CALL carrying an empty entitlement,
      // which is the one thing this module must never do by accident.
      if (!req.freeRipClaimId) {
        return { ok: false, kind: 'rejected', error: NO_FREE_RIP_CLAIM };
      }
      const spun = await deps.spinTaskReward(req.freeRipClaimId);
      if (!spun.ok) return { ok: false, kind: 'rejected', error: spun.error };
      if (!spun.redeemed) {
        return {
          ok: false,
          kind: 'rejected',
          error:
            spun.reason === 'already_redeemed'
              ? 'This free rip was already spun — the card is in your vault.'
              : 'That free rip is no longer available.',
        };
      }
      // A reward pull is never sellable, so the backend quotes no buyback —
      // the flat-rate fallback in buildOffer still yields a real offer, and
      // `locked: true` is what makes the reveal show "Keep in vault" instead.
      // The card is unsellable, not un-shippable.
      return {
        ok: true,
        batch: batchOf(
          req,
          [{ card: spun.card, pullId: spun.pullId, buyback: null }],
          deps.now(),
          null,
          true,
        ),
      };
    }

    if (req.mode === 'free-pack') {
      // The SINGLE-open route: open-batch 400s this category outright, because
      // the claim pays for exactly one pull.
      const one = await deps.openPack(req.packId);
      if (!one.ok) {
        return {
          ok: false,
          kind: 'rejected',
          error: one.error,
          needsAuth: one.needsAuth,
          needsTopUp: one.needsTopUp,
        };
      }
      return {
        ok: true,
        batch: batchOf(
          req,
          [{ card: one.card, pullId: one.pullId, buyback: one.buyback }],
          deps.now(),
          one.balance,
          one.locked,
        ),
      };
    }

    const res = await deps.openBatch(req.packId, req.reels);
    if (!res.ok) {
      return {
        ok: false,
        kind: 'rejected',
        error: res.error,
        needsAuth: res.needsAuth,
        needsTopUp: res.needsTopUp,
      };
    }
    // A 200 with no rolls (a stock race, a rule that filtered every roll) is
    // a refusal, not a win: with no winner no reel settles, and the watchdog
    // would park the machine in an empty review it can never leave.
    if (res.rolls.length === 0) {
      return { ok: false, kind: 'rejected', error: NOTHING_OPENED };
    }
    return {
      ok: true,
      batch: batchOf(req, res.rolls, deps.now(), res.balance, false),
    };
  } catch (err) {
    // The three actions handle BACKEND failures themselves ({ok:false}); what
    // escapes here is the Server Action RPC itself rejecting (offline, action
    // endpoint 5xx, deployment-ID mismatch). Whether the charge landed is
    // genuinely unknown, so this resolves — it never re-calls.
    logger.error('[roll-batch] open transport failure', err);
    return { ok: false, kind: 'unreachable' };
  }
}

/**
 * Roll one batch. The demo Spin and the paid Open are the two adapters behind
 * this call; the caller sees one shape and one failure vocabulary.
 *
 * Never throws for transport reasons — those come back as `unreachable`. A
 * throw escaping this function is a post-charge mapping bug, and the caller
 * must still surface the result the customer paid for.
 */
export async function rollBatch(
  req: RollRequest,
  deps: RollDeps,
): Promise<RollResult> {
  return req.mode === 'demo' ? demoSpin(req, deps) : openRolls(req, deps);
}
