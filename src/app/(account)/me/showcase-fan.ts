/** At most this many showcased cards are fanned on the Me page; the rest live in the Vault. */
export const FAN_MAX = 5;

/** By distance from the centre (0, 1, 2 cards out): the board's curve. */
const STEPS = [
  { y: -22, scale: 1.14 },
  { y: -10, scale: 1 },
  { y: 12, scale: 1 },
];

/**
 * Where card `i` of `n` sits in the fan: the centre raised and largest, the
 * rest falling away and turning out, 8 degrees per card. Even counts split
 * around the middle (half steps are interpolated).
 */
export function fanPose(
  i: number,
  n: number,
): { rotate: number; y: number; scale: number; z: number } {
  const k = i - (n - 1) / 2;
  const a = Math.min(Math.abs(k), STEPS.length - 1);
  const lo = STEPS[Math.floor(a)] ?? STEPS[0]!;
  const hi = STEPS[Math.ceil(a)] ?? lo;
  const f = a - Math.floor(a);
  return {
    rotate: k * 8,
    y: lo.y + (hi.y - lo.y) * f,
    scale: lo.scale + (hi.scale - lo.scale) * f,
    z: Math.round(10 - Math.abs(k) * 2),
  };
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/** "OCT 26": month and two-digit year, in UTC so server and browser agree. */
export function joinedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}
