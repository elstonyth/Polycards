// Shared display formatters for the gacha admin pages. Pure and dependency-free
// so they can be unit-tested in a node environment (see format.test.ts).

export const usd = (n: number | null): string =>
  n === null
    ? '—'
    : `$${n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

// `now` is injectable so the function is pure and testable with a fixed clock;
// the default keeps every existing callsite (`timeAgo(iso)`) byte-identical.
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const fmtPct = (n: number): string =>
  `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
