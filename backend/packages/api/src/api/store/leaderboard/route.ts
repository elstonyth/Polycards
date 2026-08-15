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
// - alltime = REAL spend: points = Σ(pack_open ledger debits, RM) × 100 — see
//   PacksModuleService.leaderboardTop.
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
// grows with total pull history; upgrade to Redis if we ever run >1 instance.
const CACHE_TTL_MS = 30_000;
const boardCache = new Map<string, { expires: number; body: unknown }>();

/** Test seam: module state outlives a test's fixtures — the http suite runs in
 *  one process, so test A's cached board would be served to test B. */
export function clearLeaderboardCache(): void {
  boardCache.clear();
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const period = req.query.period === 'alltime' ? 'alltime' : 'weekly';

  const cached = boardCache.get(period);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.body);
    return;
  }
  // Ranked top-N is aggregated in the DB (GROUP BY + ORDER BY + LIMIT) so it's
  // correct at any pull volume. weekly = pulled value over the challenge week;
  // alltime = spend. Weekly rows mirror `volume` into `points` only because the
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
  // Display-only, and deliberately so: their `pull` rows stay in the aggregate,
  // and settleChallengeWeek still ranks and pays a DISABLED player. A disable
  // is REVERSIBLE (unlike a delete, where nobody is left to pay), so hiding the
  // row must not also confiscate the week's winnings.
  //
  // Ranks are re-numbered over the survivors (1..N, no gaps): a gap would
  // publish the fact that someone was removed, which is the opposite of hiding.
  //
  // DELETED players are dropped here too — the purge writes the same disabled
  // tombstone (see disabledCustomerIds), so one filter catches both.
  //
  // KNOW WHAT THE RE-NUMBERING COSTS, because it is not the hidden player who
  // pays it. settleChallengeWeek pays `rank = i + 1` over the ORIGINAL ranking
  // and merely `continue`s past a skipped customer (service.ts, the winner
  // loop) — it never re-numbers. So every survivor BELOW a hidden player is
  // displayed one rank higher than the rank they are paid at, and
  // /leaderboard's prize table is keyed by rank, so the gap is visible to them:
  // hide the week's #1 and the player shown at #1 is paid the #2 prize. True
  // for a deleted #1 as much as a disabled one — the deleted player is not paid
  // at all, but the survivors below are still paid at their original ranks.
  // Accepted for now, and the fix if it ever produces a support ticket is to
  // re-number SETTLEMENT over the same filtered set, never to un-hide the
  // board.
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
    const body = { period, entries: [] };
    boardCache.set(period, { expires: Date.now() + CACHE_TTL_MS, body });
    res.json(body);
    return;
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

  const body = { period, entries };
  boardCache.set(period, { expires: Date.now() + CACHE_TTL_MS, body });
  res.json(body);
}
