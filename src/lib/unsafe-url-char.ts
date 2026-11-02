/** Whitespace, `\\` and control characters get stripped or reinterpreted by a
 *  browser. A pure leaf so a client component can check an href without zod. */
export const hasUnsafeUrlChar = (s: string): boolean =>
  /[\s\\]/.test(s) ||
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
