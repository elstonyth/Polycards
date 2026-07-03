import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { HANDLE_RE, seedOf } from '../../../utils/profile-handle';

// GET /store/leaderboard?period=weekly|alltime — public leaderboard. A plain
// publishable-key store route (read-only, no workflow).
//
// 🔒 PII: this is PUBLIC, so it NEVER exposes a customer's email or raw id. Each
// entry carries only a display name (first_name, else an anonymous "Collector
// ####" handle) and a stable `seed` integer the storefront hashes into an avatar.
//
// Ranking is REAL spend: points = Σ(pack_open ledger debits, RM) × 100 — see
// PacksModuleService.leaderboardTop. `volume` = Σ won-card MYR display value;
// `pulls` = pull count (reward-box draws excluded).
const TOP_N = 10;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

// Avatar seed = the shared `seedOf` (utils/profile-handle) so the leaderboard
// and the public profile page render the SAME avatar for the same customer.

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const period = req.query.period === 'alltime' ? 'alltime' : 'weekly';
  const sinceMs = period === 'weekly' ? Date.now() - WEEKLY_MS : null;

  // Ranked top-N is aggregated in the DB (GROUP BY + ORDER BY + LIMIT) so it's
  // correct at any pull volume — no more in-memory ranking of an unordered 20k
  // slice (#7). `ranked` is already points-desc, top-N, with a stable tie-break.
  const ranked = await packs.leaderboardTop({ sinceMs, limit: TOP_N });
  if (ranked.length === 0) {
    res.json({ period, entries: [] });
    return;
  }

  // Names for the ranked customers only — first_name ONLY (never email).
  // The public profile handle (customer metadata.handle, PII-safe by design)
  // rides along so the storefront can link each row to /profile/<handle>.
  // Customers that predate handle assignment return null — NO mutation here
  // (handles are assigned by the ensure-profile-handle workflow, not a GET).
  const ids = ranked.map((r) => r.customer_id);
  const customers = ids.length
    ? await customerService.listCustomers({ id: ids }, { take: ids.length })
    : [];
  const firstNameById = new Map(
    customers.map((c) => [c.id, (c.first_name || '').trim()]),
  );
  const handleById = new Map(
    customers.map((c) => {
      const handle = (c.metadata ?? {})['handle'];
      return [
        c.id,
        typeof handle === 'string' && HANDLE_RE.test(handle) ? handle : null,
      ];
    }),
  );

  const entries = ranked.map((r, i) => {
    const first = firstNameById.get(r.customer_id);
    const seed = seedOf(r.customer_id);
    return {
      rank: i + 1,
      name:
        first && first.length > 0
          ? first
          : `Collector ${String(seed).slice(0, 4)}`,
      handle: handleById.get(r.customer_id) ?? null,
      volume: r.volume,
      pulls: r.pulls,
      points: r.points,
      seed,
    };
  });

  res.json({ period, entries });
}
