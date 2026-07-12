export const LEVELS = 100;

// Mirrors foldRanges in packages/api src/modules/packs/voucher-ranges.ts —
// duplicated here (not imported) so the admin app never depends on backend
// source. Returns either the folded per-level ladder or a list of human
// -readable problems (never both), so the caller can show every issue at
// once instead of stopping at the first one.
export function foldRangesLocal(
  ranges: { from: number; to: number; amountInput: string }[],
): { levels: number[] } | { errors: string[] } {
  const errors: string[] = [];
  const out = new Array<number>(LEVELS).fill(-1);
  const overlapLevels = new Set<number>();

  for (const r of ranges) {
    if (
      !Number.isInteger(r.from) ||
      !Number.isInteger(r.to) ||
      r.from < 1 ||
      r.to > LEVELS ||
      r.from > r.to
    ) {
      errors.push(
        `Range ${r.from}–${r.to} is invalid: levels must be whole numbers within 1–${LEVELS}, with from ≤ to.`,
      );
      continue;
    }
    const amt = Number(r.amountInput);
    if (!(Number.isFinite(amt) && amt >= 0)) {
      errors.push(`Range ${r.from}–${r.to} needs an RM amount of 0 or more.`);
      continue;
    }
    for (let level = r.from; level <= r.to; level++) {
      if (out[level - 1] !== -1) overlapLevels.add(level);
      out[level - 1] = amt;
    }
  }

  if (overlapLevels.size > 0) {
    errors.push(
      `Ranges overlap at level${overlapLevels.size > 1 ? 's' : ''} ${summarizeLevels([...overlapLevels])}.`,
    );
  }

  const gaps: number[] = [];
  for (let i = 0; i < LEVELS; i++) if (out[i] === -1) gaps.push(i + 1);
  if (gaps.length > 0) {
    errors.push(
      `Level${gaps.length > 1 ? 's' : ''} ${summarizeLevels(gaps)} ${gaps.length > 1 ? 'are' : 'is'} not covered by any range.`,
    );
  }

  return errors.length > 0 ? { errors } : { levels: out };
}

// Collapses a sorted list of levels into "42" or "42–44, 90" style ranges for
// error text, so an admin sees exactly which levels are wrong instead of a
// raw array dump.
export function summarizeLevels(levels: number[]): string {
  const sorted = [...levels].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(', ');
}
