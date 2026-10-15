// Vault buyback is flat; the pack's displayed instant rate applies only while
// the reveal countdown remains open. Marketing must name the context rather
// than present either percentage as the only rate.
import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';
import { rm } from '@/lib/format';

export const BUYBACK_RATE_LABEL = `${FLAT_BUYBACK_PERCENT}%`;
export const BUYBACK_EXPLANATION = `During the reveal countdown, sell at the pack's displayed instant buyback rate. Leaving the reveal or letting the timer expire changes buyback to ${BUYBACK_RATE_LABEL} of card value in your vault. Sell-back money reaches your balance at once. Money from the welcome pack’s card, and the part of any sale paid with bonus credit, is for packs. The rest is withdrawable after your first top-up.`;

/** The toast after a sell-back lands (spec 2026-10-15, revised). `held` is
 *  the quotes' free part (`buyback.bonus`), which is for opening packs. Short
 *  (the toast lasts 4s) and never says "withdrawable": the sell surfaces do not
 *  know whether the account has topped up, and without that nothing is. */
export function sellBackNotice(amount: number, held: number): string {
  const amountSen = Math.round(amount * 100);
  const heldSen = Math.min(Math.max(0, Math.round(held * 100)), amountSen);
  const added = `${rm(amountSen / 100)} added`;
  if (heldSen === 0) return `${added}.`;
  if (heldSen === amountSen) return `${added} for opening packs.`;
  return `${added} — ${rm(heldSen / 100)} of it for packs`;
}

/** The reveal's Sell button: its label, the "RM H of it for packs" second
 *  line when part of the offer is held for packs (null otherwise), and an
 *  accessible name that reads both as one sentence (undefined when there is
 *  no second line, so the visible label names the button). In sen, so float
 *  noise never prints; the held part never exceeds the offer. */
export function sellOfferCopy(
  amount: number,
  percent: number,
  bonus: number,
): { label: string; forPacks: string | null; ariaLabel: string | undefined } {
  const label = `Sell for ${rm(amount)} (${percent}%)`;
  const heldSen = Math.min(
    Math.max(0, Math.round(bonus * 100)),
    Math.max(0, Math.round(amount * 100)),
  );
  const forPacks = heldSen > 0 ? `${rm(heldSen / 100)} of it for packs` : null;
  return {
    label,
    forPacks,
    ariaLabel: forPacks ? `${label}, ${forPacks}` : undefined,
  };
}
