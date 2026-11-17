/**
 * The money rules that run AFTER a press, decided in one place.
 *
 * `rollBatch` (roll-batch.ts) performs the press and answers in one shape; this
 * reads that answer and says what the screen must do about it: paint a balance,
 * spend or re-read the vault-pack gifts, light the Vault dot, re-read the
 * balance before the button unlocks, fire the ads pixel. It decides; it does
 * nothing. `usePackMachine` carries the effects out.
 *
 * Two rules carry the weight:
 *
 *   • IDENTITY. The await inside a press can span an account switch. Whatever
 *     a landed roll paints (balance, gifts, the Vault dot) lands only when the
 *     account that rolled is the one signed in NOW. A demo is bound to no
 *     account (`forId === null`) and carries nothing to paint.
 *   • A FAILURE MAY HAVE DEBITED. An unreachable server, or any refusal other
 *     than "top up", "log in" or "stale gifts", can come after the charge
 *     landed. Those re-read the balance BEFORE the button unlocks, so nobody is
 *     invited to spin again over a stale pre-charge figure.
 */
import { ticketTotal } from '@/lib/packs-data';
import type { RolledBatch, RollResult } from '@/lib/roll-batch';

const UNREACHABLE =
  "Couldn't reach the machine. Check your balance before spinning again.";

export type PressOutcome =
  | {
      kind: 'rolled';
      batch: RolledBatch;
      /** The balance to paint now (the charge already landed), or null. */
      applyBalance: number | null;
      /** Gifts to take off the count on screen. */
      consumeGifts: number;
      /** The pulls are vaulted as of this response — tell the Vault tab. */
      refreshVaultDot: boolean;
      /** Rows opened WITH BALANCE, for the OpenPack pixel; 0 = no event. */
      pixelRows: number;
    }
  | {
      kind: 'failed';
      /** The line under the button; null = none (the login modal speaks). */
      error: string | null;
      needsTopUp: boolean;
      openLogin: boolean;
      /** The gifts on screen may be spent or gone: re-read them. */
      resetGifts: boolean;
      refreshVaultDot: boolean;
      /** Re-read the balance, awaited, before the button unlocks. */
      refetchBalance: boolean;
    };

/**
 * What the screen must do about one press's result.
 *
 * `offeredGifts` is the gift count the press sent (`RollRequest.gifts`): a
 * failed press that offered none has no gift count to doubt.
 */
export function pressOutcome(
  result: RollResult,
  currentCustomerId: string | null,
  offeredGifts: number,
): PressOutcome {
  if (!result.ok) {
    const failed = {
      kind: 'failed' as const,
      error: null,
      needsTopUp: false,
      openLogin: false,
      resetGifts: offeredGifts > 0,
      refreshVaultDot: false,
      refetchBalance: false,
    };
    if (result.kind === 'unreachable') {
      return { ...failed, error: UNREACHABLE, refetchBalance: true };
    }
    if (result.needsAuth) return { ...failed, openLogin: true };
    // Refused BEFORE any charge: no balance hazard.
    if (result.staleGifts) return { ...failed, error: result.error };
    const needsTopUp = result.needsTopUp === true;
    return {
      ...failed,
      error: result.error,
      needsTopUp,
      // openBatch maps a post-charge mapping failure to a refusal ("the card
      // is in your Vault"), so the debit and the pull can already be real.
      refreshVaultDot: !needsTopUp,
      refetchBalance: !needsTopUp,
    };
  }

  const { batch } = result;
  const mine = batch.forId === currentCustomerId;
  // Rows a vault pack covered spent nothing; free claims and the demo spend
  // nothing at all. Not identity-guarded: the open happened either way.
  const paidRows = batch.cards.length - batch.giftsUsed;
  return {
    kind: 'rolled',
    batch,
    applyBalance: mine ? batch.balance : null,
    consumeGifts: mine ? batch.giftsUsed : 0,
    // A demo vaults nothing (forId null) and neither does a ticket roll.
    refreshVaultDot:
      batch.forId !== null && mine && ticketTotal(batch.cards) === 0,
    pixelRows: batch.mode === 'paid' && paidRows > 0 ? paidRows : 0,
  };
}
