import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';

// GET /store/leaderboard?period=weekly|alltime — public leaderboard. A plain
// publishable-key store route (read-only, no workflow).
//
// 🔒 PII: this is PUBLIC, so it NEVER exposes a customer's email or raw id. Each
// entry carries only a display name (first_name, else an anonymous "Collector
// ####" handle) and a stable `seed` integer the storefront hashes into an avatar.
//
// Rankings (Weekly Pulled Value Challenge standard, 2026-07-19):
// - weekly  = the Weekly Pull Value board: ranked by pulled value over the
//   challenge-anchored week (challengeWeekTop) — the SAME board /task's top-10
//   shows, so the challenge payout and the leaderboard can never disagree.
// - alltime = lifetime pulled value (`volume`, the figure the board shows),
//   over players with real pack-open spend; points = Σ(pack_open ledger
//   debits, RM) × 100 — see PacksModuleService.leaderboardTop.
// `volume` = Σ won-card MYR display value; `pulls` = pull count (reward-box
// draws excluded on both paths).
const TOP_N = 10;
// Over-fetch, because the disabled filter below runs AFTER the aggregate: a
// disabled player in the top 10 must not shorten the board to 9. Double is the
// bound — a board where more than half the top 20 are disabled renders short,
// which is the honest outcome.
const FETCH_N = TOP_N * 2;

// Avatar seed = the shared `seedOf` (utils/profile-handle) so the leaderboard
// and the public profile page render the SAME avatar for the same customer.

// ponytail: per-process 30s cache — the board is a global aggregate whose cost
// grows with total pull history.
// >1 instance since #473: per-process is accepted — N instances = N
// computes per window and ≤TTL cross-instance skew, display-only either
// way. Decision + upgrade path recorded in plan 116.
const CACHE_TTL_MS = 30_000;
const boardCache = new Map<string, { expires: number; body: unknown }>();
// Single-flight per period: misses during an expiry window share ONE compute
// instead of each running the whole-history aggregate (the #835 stampede
// shape; audit 2026-11-11).
const inFlight = new Map<string, Promise<unknown>>();

/** Test seam: module state outlives a test's fixtures — the http suite runs in
 *  one process, so test A's cached board would be served to test B. */
export function clearLeaderboardCache(): void {
  boardCache.clear();
  inFlight.clear();
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const period = req.query.period === 'alltime' ? 'alltime' : 'weekly';

  const cached = boardCache.get(period);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.body);
    return;
  }
  let compute = inFlight.get(period);
  if (!compute) {
    compute = computeBoard(req, period)
      .then((body) => {
        boardCache.set(period, { expires: Date.now() + CACHE_TTL_MS, body });
        return body;
      })
      .finally(() => inFlight.delete(period));
    inFlight.set(period, compute);
  }
  // A rejected compute rejects every waiter alike, minus the duplicate work.
  res.json(await compute);
}

async function computeBoard(
  req: MedusaRequest,
  period: 'alltime' | 'weekly',
): Promise<unknown> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);
  // Ranked top-N is aggregated in the DB (GROUP BY + ORDER BY + LIMIT) so it's
  // correct at any pull volume. weekly = pulled value over the challenge week;
  // alltime = lifetime pulled value. Weekly rows mirror `volume` into `points` only because the
  // wire shape requires a finite points field — the weekly UI renders volume.
  let ranked: {
    customer_id: string;
    pulls: number;
    points: number;
    volume: number;
  }[];
  if (period === 'weekly') {
    const s = await packs.challengeSettings();
    const rows = await packs.challengeWeekTop({
      timezone: s.timezone,
      resetDay: s.reset_day,
      resetHour: s.reset_hour,
      limit: FETCH_N,
    });
    ranked = rows.map((r) => ({
      customer_id: r.customer_id,
      pulls: r.pulls,
      volume: r.volumeMyr,
      points: r.volumeMyr,
    }));
  } else {
    ranked = await packs.leaderboardTop({ sinceMs: null, limit: FETCH_N });
  }
  // An administratively disabled player is hidden from every public surface —
  // disabling an account from the dashboard must not leave it on display here.
  //
  // Their `pull` rows stay in the aggregate (and in the weekly pool); only the
  // ranking drops them.
  //
  // Ranks are re-numbered over the survivors (1..N, no gaps): a gap would
  // publish the fact that someone was removed, which is the opposite of hiding.
  //
  // DELETED players are dropped here too — the purge writes the same disabled
  // tombstone (see disabledCustomerIds), so one filter catches both.
  //
  // settleChallengeWeek applies the SAME filter and re-numbers the same way
  // (owner, 2026-11-06), so the rank shown here is the rank paid: a player
  // still disabled when the week is first settled is not paid, and everyone
  // below moves up. This used to be display-only, which paid the player shown
  // at #1 the #2 prize whenever the real #1 was hidden.
  //
  // NOT filtered, and known: GET /store/pulls/recent, the live pull feed on the
  // home, pack-detail and spin pages. It builds its own display name and shows
  // a FULL first_name, so it is the most identifying surface of the four — but
  // it was left out of this pass while another change was in flight in that
  // file. Bounded rather than harmless: a disabled player cannot pull again
  // (the session guard 403s them), and the feed keeps only the newest 12 rows,
  // so their rows age out. Deleted players already read as "Anonymous" there,
  // because the purge nulls first_name. Filtering it is one disabledCustomerIds
  // call in that route.
  const disabled = await packs.disabledCustomerIds(
    ranked.map((r) => r.customer_id),
  );
  ranked = ranked
    .filter((r) => !disabled.has(r.customer_id))
    .slice(0, TOP_N);
  if (ranked.length === 0) {
    return { period, entries: [] };
  }

  // PII-safe display fields (name / handle / avatar) come from the shared
  // publicProfileFields helper — first_name or an anonymous "Collector ####",
  // never email/id; the handle links each row to /profile/<handle>. Customers
  // that predate handle assignment return null (handles are assigned by the
  // ensure-profile-handle workflow, not a GET). equipped_frame_level is
  // leaderboard-specific, so it stays inline.
  const ids = ranked.map((r) => r.customer_id);
  const customers = ids.length
    ? await customerService.listCustomers({ id: ids }, { take: ids.length })
    : [];
  const byId = new Map(customers.map((c) => [c.id, c]));

  const entries = ranked.map((r, i) => {
    const seed = seedOf(r.customer_id);
    const c = byId.get(r.customer_id);
    const p = publicProfileFields(c, seed);
    const meta = (c?.metadata ?? {}) as Record<string, unknown>;
    return {
      rank: i + 1,
      name: p.name,
      handle: p.handle,
      volume: r.volume,
      pulls: r.pulls,
      points: r.points,
      seed,
      avatar_url: p.avatarUrl,
      equipped_frame_level:
        typeof meta['equipped_frame_level'] === 'number'
          ? (meta['equipped_frame_level'] as number)
          : null,
    };
  });

  return { period, entries };
}
