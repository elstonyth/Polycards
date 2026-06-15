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

export const usd = (n: number) => money(n, { currency: true });

export const usd0 = (n: number) => money(n, { currency: true, decimals: 0 });

export const compact = (n: number) =>
  n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const num = (n: number) => n.toLocaleString('en-US');
