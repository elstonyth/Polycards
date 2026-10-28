// Small formatting helpers shared across the mock app pages.

// `n.toLocaleString(locale, options)` builds a fresh Intl.NumberFormat on EVERY
// call: ~17µs against ~0.4µs for reusing one (Node 24). Every price on every
// SSR render and poll goes through money(), and on 2026-10-25 that was the
// storefront's hot path (pods blocked long enough to fail /healthz → 503s).
// Same locale + options give byte-identical output, so reuse one per shape.
const formatters = new Map<string, Intl.NumberFormat>();
const numberFormat = (
  key: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat => {
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', options);
    formatters.set(key, f);
  }
  return f;
};

// One USD/number formatter. prefix+formatted number for the "$"/"US$" family;
// currency:true uses Intl currency style (kept for `usd`'s exact output).
export function money(
  amount: number,
  opts: { decimals?: number; prefix?: string; currency?: boolean } = {},
): string {
  const { decimals = 2, prefix = '$', currency = false } = opts;
  if (currency) {
    return numberFormat(`usd:${decimals}`, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  }
  return (
    prefix +
    numberFormat(`fixed:${decimals}`, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount)
  );
}

export const rm = (n: number) => money(n, { prefix: 'RM ' });
export const rm0 = (n: number) => money(n, { prefix: 'RM ', decimals: 0 });
/** Whole ringgit without the ".00", sen only when there are some — so
 *  RM 99.99 never rounds up to a "done-looking" RM 100. */
export const rmAuto = (n: number) => (Number.isInteger(n) ? rm0(n) : rm(n));
/** `rm` with a non-breaking space, for figures inside running sentences so
 *  "RM" never wraps away from its number. */
// Built from its code point: a literal U+00A0 in source gets flattened back
// into a plain space by editors and formatters, silently (see task-hub.ts).
export const rmNbsp = (n: number) =>
  money(n, { prefix: `RM${String.fromCharCode(0xa0)}` });
/** Singapore dollars — what an A3Pay customer pays or receives. */
export const sgd = (n: number) => money(n, { prefix: 'S$' });
export const sgd0 = (n: number) => money(n, { prefix: 'S$', decimals: 0 });
/** Tether — what a GlobePay365 customer pays or receives. */
export const usdt = (n: number) => money(n, { prefix: 'USDT ' });
export const usdt0 = (n: number) => money(n, { prefix: 'USDT ', decimals: 0 });

// Affordability compared in integer sen, never raw floats: a fractional pack
// price times a reel/qty count (e.g. 1.1 * 3 === 3.3000000000000003) can read
// as just over an exactly-equal balance and false-block a spin the player can
// afford. Prices carry at most 2 decimals, so rounding to sen is exact.
const sen = (n: number) => Math.round(n * 100);
export const affordable = (balance: number, cost: number) =>
  sen(balance) >= sen(cost);

// Single wording for a VIP reward grant (voucher or frame), shared by /daily
// and /vouchers — was two independently-drifted copies.
// UNUSED while the reward surfaces are suspended (2026-07-29): both callers
// were deleted. Kept so the revert stays a revert — don't prune it.
export function voucherLabel(grant: {
  kind: 'voucher' | 'frame';
  level: number;
  amountMyr?: number;
}): string {
  return grant.kind === 'voucher'
    ? rm(grant.amountMyr ?? 0)
    : `LV ${grant.level} Frame`;
}

export const compact = (n: number) =>
  numberFormat('compact', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);

export const num = (n: number) => numberFormat('num', {}).format(n);

// Coarse relative time for the activity / recent-pulls feeds ("3h ago",
// "2d ago"). Future and unparsable dates read as "just now"; `now` is injectable
// so the cascade is testable without mocking the clock. The single home for what
// were two drifted copies (data/packs.relativeTime + profile-view.timeAgo).
export function relativeTime(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MYT_OFFSET_MS = 8 * 3_600_000;

// Absolute roll time for the pull-history rows: "02 Sep, 09:38:44 PM". Fixed to
// Malaysian time (UTC+8, never DST — the same fixed shift the backend ledger
// uses) rather than the viewer's zone, so the server render and the client
// hydration print the SAME string: a zone-dependent format mismatches whenever
// the server (UTC) and the phone (MYT) disagree, and React would leave the
// server's text on screen. Hand-rolled over Intl for the same determinism —
// ICU's en-GB gives "Sept" / "pm" and varies by node build. Unparsable → "".
export function pullTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + MYT_OFFSET_MS);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  const second = String(d.getUTCSeconds()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]}, ${String(h12).padStart(2, '0')}:${minute}:${second} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// Calendar date in Malaysian time ("19 Oct 2026") — the referral friend
// list's joined dates, /transactions and /orders. Fixed UTC+8 and hand-rolled
// for the same server/client parity as pullTime. Unparsable → "".
export function mytDate(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + MYT_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Wall-clock time in Malaysian time ("10:27 PM") for the /transactions rows.
// That page renders on the UTC server, so a plain Intl formatter printed a
// 10:27 PM withdrawal as "2:27 PM" and customers read an 8-hour wait into it.
// Unparsable → "".
export function mytClock(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + MYT_OFFSET_MS);
  const h24 = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h24 % 12 || 12}:${minute} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// The mirror of relativeTime for a FUTURE instant ("in 45m", "in 23h", "in 2d")
// — used by the saved-payout-account surfaces to say when a cooling-off
// destination becomes usable. Returns null for a time that has already passed
// or cannot be parsed, so callers branch on "is there still a wait" rather than
// rendering "in 0m". Rounds UP: a label must never promise a moment that is
// still refused server-side.
export function timeUntil(iso: string, now: Date = new Date()): string | null {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}
