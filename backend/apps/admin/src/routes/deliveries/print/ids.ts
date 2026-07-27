// Parsing for the packing-slip route's ?ids= list. Split out of page.tsx so it
// can be unit-tested — the admin vitest runner is node-only and globs
// `src/**/*.test.ts`, so logic that has to be covered cannot live in a .tsx.

// One fetch + one printed block per id, so the list is capped. The bulk bar can
// never exceed this on its own (page size 50, and the selection clears whenever
// the visible rows change), which makes the cap purely a hand-edited-URL guard.
export const PRINT_ID_CAP = 100;

/**
 * Split the raw `ids` query value into order ids, preserving the operator's
 * selection order. Blanks are dropped and duplicates collapsed: a trailing
 * comma or a hand-edited URL would otherwise print an empty block, duplicate
 * React keys, and fetch the same order twice.
 */
export function parsePrintIds(raw: string | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}
