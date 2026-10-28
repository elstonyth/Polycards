// Tier colours, mirrored from the storefront's RARITY_RGB (src/lib/rarity.ts)
// so a Legendary reads the same pink here as on the customer's card frame.
export const TIER_RGB: Record<string, string> = {
  Immortal: '251, 146, 60',
  Legendary: '236, 72, 153',
  Mythical: '168, 85, 247',
  Rare: '37, 99, 235',
  Uncommon: '56, 189, 248',
  Common: '163, 163, 163',
};

export const TIER_ORDER = Object.keys(TIER_RGB);

export const tierColor = (rarity: string, alpha = 1) =>
  `rgba(${TIER_RGB[rarity] ?? TIER_RGB.Common}, ${alpha})`;

/** "3 min ago" / "2 h ago" / a date, for activity feeds. */
export function ago(iso: string | number, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}
