import type { CustomerMoney } from '../../../lib/admin-rest';

/** The note under "Withdrawable now" (a playerMoney.* key): why nothing, or
 *  not everything, can leave. Frozen and never-topped-up outrank the rest,
 *  as in the withdraw gate; otherwise whatever is held back is named — the
 *  bonus, the money still to use on packs, or both. */
export function withdrawableNote(
  w: CustomerMoney['wallet'],
):
  | { key: 'frozenNote' | 'noTopupNote' | 'withdrawableNote' }
  | { key: 'heldBoth' | 'heldBonus' | 'heldPlay'; held: number } {
  if (w.frozen) return { key: 'frozenNote' };
  if (!w.has_topup) return { key: 'noTopupNote' };
  const held = Math.round((w.balance - w.withdrawable) * 100) / 100;
  if (held <= 0) return { key: 'withdrawableNote' };
  const bonus = w.bonus > 0;
  const play = w.playthrough.remaining > 0;
  return {
    key: bonus && play ? 'heldBoth' : bonus ? 'heldBonus' : 'heldPlay',
    held,
  };
}
