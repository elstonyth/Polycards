// A timestamp as res.json sends it: a Date becomes its ISO string (what
// JSON.stringify does with a Date) and a string goes out untouched, so typing
// a response as `string` never changes its bytes (ADR 0017).
export const wireDate = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : v;

export const wireDateOrNull = (
  v: Date | string | null | undefined,
): string | null => (v === null || v === undefined ? null : wireDate(v));
