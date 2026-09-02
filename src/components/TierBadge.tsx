import { rarityRgb } from '@/lib/rarity';
import type { Rarity } from '@/lib/packs-data';

/** Badge ink: black on the light tiers, white on the one dark one (Rare's
 *  blue-600) — both sides clear 4.5:1 on their own tier fill. */
function badgeInk(rgb: string): string {
  const [r = 0, g = 0, b = 0] = rgb.split(',').map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 120 ? '#0a0a0a' : '#fafafa';
}

/** The solid tier chip ("IMMORTAL") the pull-history panel and its stats
 *  chart share — tier hue as the fill, ink picked for contrast. */
export function TierBadge({ rarity }: { rarity: Rarity }) {
  const rgb = rarityRgb(rarity);
  return (
    <span
      className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide"
      style={{ backgroundColor: `rgb(${rgb})`, color: badgeInk(rgb) }}
    >
      {rarity}
    </span>
  );
}
