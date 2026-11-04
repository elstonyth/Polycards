import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  publicCoinFlipRound,
  type CoinFlipRoundRecord,
} from '../../../../modules/packs/coin-flip';
import { loadPullerProfiles } from '../../pulls/pullers';

// GET /store/coin-flips/recent: every player's latest settled flips, for the
// coin flip page's Everyone view (owner 2026-11-04). The public-feed rules of
// /store/pulls/recent apply: display name, handle, avatar and frame, never an
// id or email, and a disabled player's flips are dropped. Each row is the same
// publicCoinFlipRound the owner's history gets, so no roll or odds leave.
const RECENT_LIMIT = 20;
// Over-fetch so dropped disabled players don't shorten the list.
const FETCH_LIMIT = RECENT_LIMIT * 2;
// Every open coin flip page polls this. One read per status per 5s window per
// process, and requests in that window share the read already in flight.
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { expires: number; body: Promise<unknown> }>();

/** Test seam: one jest process is one module instance. */
export function clearRecentCoinFlipsCache(): void {
  cache.clear();
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const only = req.query.status;
  const status = only === 'won' || only === 'lost' ? [only] : ['won', 'lost'];
  const key = status.join();
  let hit = cache.get(key);
  if (!hit || hit.expires <= Date.now()) {
    const entry = {
      expires: Date.now() + CACHE_TTL_MS,
      body: buildFeed(req, status),
    };
    entry.body.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    cache.set(key, entry);
    hit = entry;
  }
  res.json(await hit.body);
}

async function buildFeed(
  req: AuthenticatedMedusaRequest,
  status: string[],
): Promise<unknown> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const fetched = (await packs.listCoinFlipRounds(
    { status },
    { take: FETCH_LIMIT, order: { settled_at: 'DESC', id: 'DESC' } },
  )) as unknown as CoinFlipRoundRecord[];
  const players = await loadPullerProfiles(
    req,
    packs,
    fetched.map((row) => row.customer_id),
  );
  return {
    rounds: fetched
      .filter((row) => !players.disabled.has(row.customer_id))
      .slice(0, RECENT_LIMIT)
      .map((row) => ({
        ...publicCoinFlipRound(row),
        ...players.profileOf(row.customer_id, row.id),
      })),
  };
}
