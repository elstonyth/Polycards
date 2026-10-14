import { rm } from '../../lib/format';

/** '− RM 1,234.00': the sign in front of the currency, as the money trail
 *  writes it, never 'RM -1,234.00'. Zero (and −0) is plain 'RM 0.00'. */
export const signed = (n: number): string =>
  n < 0 ? `− ${rm(Math.abs(n))}` : rm(Math.abs(n));

/** A gap or change with its sign in front: '+ RM 12.00', '− RM 111.81'. */
export const delta = (n: number): string => (n > 0 ? `+ ${rm(n)}` : signed(n));

/**
 * One "where the money moved" line. On a money-OUT line (sell-backs, promo,
 * commission, adjustments) a positive figure was paid out and reads '−'; a
 * negative one was taken back and reads '+'. On a money-IN line (pack sales,
 * delivery fees) a negative figure was refunded and reads '−'.
 */
export const flowLine = (v: number, out: boolean): string => {
  if (v === 0) return rm(0);
  if (out) return v > 0 ? `− ${rm(v)}` : `+ ${rm(Math.abs(v))}`;
  return v < 0 ? `− ${rm(Math.abs(v))}` : rm(v);
};
