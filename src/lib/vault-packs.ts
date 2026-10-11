// Vault packs (admin-gifted, unopened packs) and bonus credit — the wording
// the pack page, spin page, reveal and vault use for them. Pure, so the copy
// is unit-tested once instead of re-derived per surface. Spec 2026-10-07 §1.
//
// Use order on every open is gifts → bonus credit → normal credit; only the
// gift part is decided here (how many rows a gift covers). The bonus/normal
// split of the paid rows is the backend's.
import { money, rm } from '@/lib/format';

/** One pack held as a gift — `GET /store/pack-gifts`, mapped. */
export type PackGift = {
  /** Pack slug — the `/slots/<slug>` route. */
  packId: string;
  count: number;
  title: string;
  image: string | null;
  price: number;
  /** false = the pack cannot be opened right now (inactive). */
  available: boolean;
};

/** Gifts an open of `qty` rows uses: they cover rows first. */
export const giftsUsed = (qty: number, held: number): number =>
  Math.min(qty, Math.max(0, held));

/** Gifts held for this pack that an open can actually use. */
export const giftsHeldFor = (
  gifts: readonly PackGift[] | null,
  slug: string,
): number =>
  (gifts ?? [])
    .filter((g) => g.packId === slug && g.available)
    .reduce((n, g) => n + g.count, 0);

/** Pack page price line: "Vault x1" / "Vault x1 + RM 300.00"; null = no gifts. */
export function vaultCostLabel(
  qty: number,
  gifts: number,
  price: number,
): string | null {
  if (gifts <= 0) return null;
  const paid = qty - gifts;
  return paid > 0 ? `Vault x${gifts} + ${rm(paid * price)}` : `Vault x${gifts}`;
}

/** Spin page bet line: "Bet Vault x1" / "Bet Vault x1 + RM300.00"; null = no
 *  gifts. No space after "RM" — the existing bet's Meter collapses it, so the
 *  screen reads "Bet RM300.00" and this must match it. */
export function spinBetLabel(
  reels: number,
  gifts: number,
  price: number,
): string | null {
  if (gifts <= 0) return null;
  const paid = reels - gifts;
  return paid > 0
    ? `Bet Vault x${gifts} + ${money(paid * price, { prefix: 'RM' })}`
    : `Bet Vault x${gifts}`;
}

/** Pack page button: "Open Vault xG" when every row is a gift, else null
 *  (keep "Open Pack"). */
export const vaultButtonLabel = (qty: number, gifts: number): string | null =>
  gifts > 0 && gifts === qty ? `Open Vault x${gifts}` : null;
