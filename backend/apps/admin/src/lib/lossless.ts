/**
 * "Packs" column of the Lossless Mode schedule table: null scope = every paid
 * pack, otherwise the chosen titles. A slug with no title (pack deleted since
 * the window was scheduled) is shown raw rather than dropped, so the operator
 * can still see what the window was aimed at.
 */
export const packsLabel = (
  slugs: string[] | null,
  titleBySlug: Map<string, string>,
  allLabel = 'All packs',
): string =>
  slugs === null
    ? allLabel
    : slugs.map((s) => titleBySlug.get(s) ?? s).join(', ');

// Mirrors FREE_WELCOME_CATEGORY / REWARD_BOX_CATEGORY in the API: promo grants
// never get Lossless Mode, and POST /admin/lossless-schedules refuses a window
// that names one, or a ticket pack. Literals, not imports — the admin app is a
// separate build.
const INELIGIBLE_CATEGORIES: ReadonlySet<string> = new Set([
  'free_welcome',
  'reward_box',
]);

/** The packs an operator may pick for a window: the paid ones. */
export const losslessEligiblePacks = <
  T extends { category: string; prize_type?: string },
>(
  packs: readonly T[],
): T[] =>
  packs.filter(
    (p) => !INELIGIBLE_CATEGORIES.has(p.category) && p.prize_type !== 'tickets',
  );
