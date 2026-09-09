import { isDefaultPlayerGroup, isPartnerGroup } from './player-groups';

// Partner account generator rules the modal needs. Credentials are generated
// SERVER-SIDE (POST /admin/players) — nothing here mints anything.

/** Mirrors MAX_BATCH in api/admin/players/route.ts. */
export const MAX_BATCH = 50;

type GroupLike = {
  id: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** The group the generator preselects: the first partner group (that is what
 *  operator-minted accounts are for), else DEFAULT, else nothing. */
export const defaultGroupForNewPlayer = (
  groups: readonly GroupLike[],
): string =>
  (groups.find(isPartnerGroup) ?? groups.find(isDefaultPlayerGroup))?.id ?? '';

/** Batch size as typed: an integer in 1..MAX_BATCH, else null. */
export const parseBatchCount = (raw: string): number | null => {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_BATCH ? n : null;
};

/** Tab-separated `name  email  password` lines — what "Copy all" puts on the
 *  clipboard, pasteable straight into a sheet. */
export const credentialLines = (
  rows: readonly { name: string | null; email: string; password: string }[],
): string =>
  rows.map((r) => `${r.name ?? ''}\t${r.email}\t${r.password}`).join('\n');
