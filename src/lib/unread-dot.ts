// Pure logic behind the app's unread dots — the Vault tab, and the Me tab's
// money dot. Deliberately outside the providers: this is the only branching
// part of the feature, and it is testable here without React, a DOM, or
// localStorage.

/** Which dot a stamp belongs to. One key namespace per surface. */
export type DotScope = 'vault' | 'credits';

/**
 * localStorage key holding a customer's last-seen stamp for one dot.
 *
 * ALWAYS keyed by customer id. TopUpProvider carries the scar in its own
 * comment — "on logout→login as a different account, an untagged balance
 * briefly leaked the previous user's amount" — and an untagged stamp fails the
 * same way, handing account B account A's cleared dot.
 *
 * The vault scope yields exactly the key the shipped Vault dot already writes
 * (`polycards.vault_seen_at:<id>`), so generalising this does not reset anyone's
 * stamp and re-light a dot they had already cleared.
 */
export function seenKey(scope: DotScope, customerId: string): string {
  return `polycards.${scope}_seen_at:${customerId}`;
}

/**
 * True when the surface holds something the customer has not seen.
 *
 * Both arguments are ISO 8601 strings or null. The two degradation directions
 * are chosen, not accidental:
 *   - unparseable/absent STAMP → show. Costs one extra tab tap, self-heals on
 *     the next visit; hiding would swallow real arrivals forever.
 *   - unparseable/absent EVENT → hide. Never show a dot we cannot justify.
 *
 * A stamp AHEAD of the newest event (clock skew, a stale write) shows nothing:
 * the comparison is strictly `>`.
 */
export function shouldShowDot(
  latestAt: string | null,
  seenAt: string | null,
): boolean {
  if (!latestAt) return false;
  const latest = Date.parse(latestAt);
  if (Number.isNaN(latest)) return false;

  if (!seenAt) return true;
  const seen = Date.parse(seenAt);
  if (Number.isNaN(seen)) return true;

  return latest > seen;
}
