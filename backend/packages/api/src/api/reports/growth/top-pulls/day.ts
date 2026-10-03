import { MedusaError } from '@medusajs/framework/utils';

const MYT_MS = 8 * 60 * 60 * 1000; // Malaysia is UTC+8 all year
const DAY_MS = 24 * 60 * 60 * 1000;
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

/** One Malaysia calendar day (`YYYY-MM-DD`) as a UTC window [from, to);
 *  no day = yesterday in Malaysia, the day a 12 a.m. drop reports on. */
export function malaysiaDay(
  raw: unknown,
  now = new Date(),
): { day: string; from: Date; to: Date; label: string } {
  let day: string;
  if (raw === undefined || raw === '') {
    day = new Date(now.getTime() + MYT_MS - DAY_MS).toISOString().slice(0, 10);
  } else {
    const parsed =
      typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(`${raw}T00:00:00.000Z`)
        : null;
    // A real date only: '2026-02-30' parses but rolls into March.
    if (
      !parsed ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== raw
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'day must be a date, YYYY-MM-DD (Malaysia time).',
      );
    }
    day = raw as string;
  }
  const from = new Date(Date.parse(`${day}T00:00:00.000Z`) - MYT_MS);
  const [y, m, d] = day.split('-').map(Number);
  return {
    day,
    from,
    to: new Date(from.getTime() + DAY_MS),
    label: `${d} ${MONTHS[m - 1]} ${y}`,
  };
}

/** `limit`: a whole number from 1 to 20, default 10. */
export function topPullsLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return 10;
  if (
    typeof raw !== 'string' ||
    !/^\d{1,2}$/.test(raw) ||
    Number(raw) < 1 ||
    Number(raw) > 20
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'limit must be a whole number from 1 to 20.',
    );
  }
  return Number(raw);
}
