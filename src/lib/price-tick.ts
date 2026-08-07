/**
 * State machine behind the card-detail live price pulse (globals.css
 * `priceTick`). Pure, because getting it wrong is invisible on the surface it
 * was written for and obvious on the one it wasn't: `/card/[handle]` renders a
 * single card whose price is already correct on the first paint, while the grid
 * overlay hydrates from a seed and gets reused across cards. Both must stay
 * silent unless the market actually moved.
 *
 * Two things are deliberately NOT a pulse:
 *  - the first numeric price we ever see for a card (the overlay's ~1s hydrate
 *    from its seed) — that's the baseline being established, not a change;
 *  - a card→card switch in the overlay, which mirrors the `prevHandle` reset in
 *    use-card-price.ts. Without it, card B's first price is compared against
 *    card A's and every switch flashes.
 *
 * `n` increments per pulse and is used as a React key so the CSS animation
 * re-arms; `up` picks the signal colour (money-in green / alarm red).
 */
export type PriceTick = {
  handle: string;
  price: number | null;
  n: number;
  up: boolean;
};

export function initialPriceTick(
  handle: string,
  price: number | null,
): PriceTick {
  return { handle, price, n: 0, up: true };
}

/**
 * Cents — the smallest unit the UI actually renders. Comparing raw floats
 * would pulse on a sub-cent FX wobble that leaves the displayed string
 * identical, which reads as the page flashing for no reason.
 */
const cents = (v: number) => Math.round(v * 100);

/** Next state for (handle, price). Returns `prev` unchanged when nothing moved. */
export function nextPriceTick(
  prev: PriceTick,
  handle: string,
  price: number | null,
): PriceTick {
  if (prev.handle !== handle) return initialPriceTick(handle, price);
  if (price === null) return prev;
  // First real price for this card — baseline it, never pulse.
  if (prev.price === null) return { ...prev, price };
  if (cents(price) === cents(prev.price)) return prev;
  return { handle, price, n: prev.n + 1, up: price > prev.price };
}
