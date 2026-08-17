// Live catalog resolution for the E2E suite.
//
// The specs used to hardcode invented pack slugs ('pokemon-rookie',
// 'pokemon-elite') with hand-tuned top-up constants ("rookie RM25, elite RM50:
// 3 opens of each = RM225"). Two problems: the packs existed nowhere but the
// fixture, and every price change silently broke the funding arithmetic in six
// files at once.
//
// So: read the catalog the storefront actually serves (GET /store/packs — the
// same route the /slots page uses, which lists only ACTIVE, openable packs), and
// derive funding from the live price. The fixture now installs the real prod
// packs (bronze-pack … diamond-pack), so a spec that asks for "the cheapest
// pack" gets the same pack a real customer would start with.
import { api } from './api';

export interface TestPack {
  slug: string;
  title: string;
  /** RM price of ONE open — the live figure, not a constant. */
  price: number;
}

interface StorePackRow {
  slug: string;
  title: string;
  price: number;
  in_stock?: boolean;
}

// Throwaway packs the suite itself creates (admin.spec's `pw-pack-<stamp>`).
// They are priced far below the real catalog, so a run that died before its
// cleanup would leave one behind and make it the "cheapest pack" every later
// spec picks. Excluded here rather than relying on the seed to sweep it, which
// only helps if you reseed between runs.
const THROWAWAY = /^pw-pack-/;

// Per-process cache: the catalog is read-only for the suite and every spec file
// in a run shares the same worker.
let cached: Promise<TestPack[]> | null = null;

/** Active, openable packs, CHEAPEST FIRST. */
export function catalog(): Promise<TestPack[]> {
  cached ??= api<{ packs: StorePackRow[] }>('/store/packs').then(
    ({ packs }) => {
      const usable = packs
        .filter(
          (p) => p.in_stock !== false && p.price > 0 && !THROWAWAY.test(p.slug),
        )
        .map((p) => ({ slug: p.slug, title: p.title, price: Number(p.price) }))
        .sort((a, b) => a.price - b.price);
      if (usable.length === 0) {
        throw new Error(
          'No openable pack in GET /store/packs — seed the catalog first ' +
            '(`corepack yarn seed:e2e` from backend/packages/api).',
        );
      }
      return usable;
    },
  );
  return cached;
}

/** The pack most specs should drive: cheapest, so funding stays small. */
export async function primaryPack(): Promise<TestPack> {
  return (await catalog())[0]!;
}

/** Two DISTINCT packs for the specs that MUTATE a pack's odds.
 *
 *  Deliberately NOT the primary pack: odds-reflection locks a card at 100% and
 *  restores in a `finally`, so a crash between those two points leaves the pack
 *  rigged. Keeping the mutators off the pack every other spec opens confines
 *  that blast radius to packs nothing else reads. (A re-seed also resets pool
 *  weights now, so this is the second line of defence, not the only one.)
 *  Falls back toward the front only on a catalog too small to isolate. */
export async function mutationPacks(): Promise<[TestPack, TestPack]> {
  const packs = await catalog();
  return [packs[1] ?? packs[0]!, packs[2] ?? packs[1] ?? packs[0]!];
}

/** RM needed to open `pack` `opens` times, with headroom for the buyback/fee
 *  rounding the flows do afterwards. Rounded up to a whole RM — the top-up form
 *  and the mock gateway both work in whole ringgit. */
export function fundFor(pack: TestPack, opens = 1): number {
  return Math.ceil(pack.price * opens + Math.max(10, pack.price * 0.1));
}
