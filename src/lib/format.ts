// Small formatting helpers shared across the mock app pages.

// One USD/number formatter. prefix+toLocaleString for the "$"/"US$" family;
// currency:true uses Intl currency style (kept for `usd`'s exact output).
export function money(
  amount: number,
  opts: { decimals?: number; prefix?: string; currency?: boolean } = {},
): string {
  const { decimals = 2, prefix = '$', currency = false } = opts;
  if (currency) {
    return amount.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  return (
    prefix +
    amount.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

export const rm = (n: number) => money(n, { prefix: 'RM ' });
export const rm0 = (n: number) => money(n, { prefix: 'RM ', decimals: 0 });

// Affordability compared in integer sen, never raw floats: a fractional pack
// price times a reel/qty count (e.g. 1.1 * 3 === 3.3000000000000003) can read
// as just over an exactly-equal balance and false-block a spin the player can
// afford. Prices carry at most 2 decimals, so rounding to sen is exact.
const sen = (n: number) => Math.round(n * 100);
export const affordable = (balance: number, cost: number) =>
  sen(balance) >= sen(cost);

// Single wording for a VIP reward grant (voucher or frame), shared by /daily
// and /vouchers — was two independently-drifted copies.
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
  n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const num = (n: number) => n.toLocaleString('en-US');

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
