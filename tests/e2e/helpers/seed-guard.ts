// Fail-fast seed preflight. The suite drives the REAL catalog (the packs
// production serves — bronze-pack … diamond-pack, installed locally by the
// prod-catalog mirror in seed:e2e). Against a fresh or drifted DB those packs
// are missing or still empty drafts, and a spec then fails opaquely deep in a
// flow (this bit us in plan 023). Assert up front, with a message that names the
// fix — so a missing seed reads as "reseed the DB", not a mystery timeout.
import { BACKEND, PK } from './constants';

// Two, not five: the suite only needs enough openable packs for the A/B odds
// spec, and pinning the exact catalog size here would make an operator adding a
// sixth pack look like a broken seed. Which packs those are is resolved live —
// see helpers/catalog.ts.
const MIN_OPENABLE_PACKS = 2;

// The fixture that fills them: the prod catalog seed (seed.ts) ships packs as
// empty DRAFTS by design, so the fix for a missing/unopenable pack is seed:e2e,
// not seed. Refresh the mirrored catalog itself with
// `node scripts/snapshot-prod-catalog.mjs` from the repo root.
const RESEED_HINT =
  'reseed with `corepack yarn seed:e2e` from backend/packages/api';

interface StorePack {
  slug: string;
  price: number;
}

async function storeGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      headers: { 'x-publishable-api-key': PK },
    });
  } catch (err) {
    throw new Error(
      `Seed preflight: GET ${BACKEND}${path} failed to connect — is the backend up? (${err})`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Seed preflight: GET ${path} -> ${res.status}. Backend up at ${BACKEND}? ${RESEED_HINT}.`,
    );
  }
  return (await res.json()) as T;
}

export async function assertSeedPacks(): Promise<void> {
  const { packs } = await storeGet<{ packs: StorePack[] }>('/store/packs');
  const openable = packs.filter((p) => p.price > 0);
  if (openable.length < MIN_OPENABLE_PACKS) {
    throw new Error(
      `Seed preflight: only ${openable.length} openable pack(s) in the catalog, ` +
        `need ${MIN_OPENABLE_PACKS} — ${RESEED_HINT}.`,
    );
  }

  // An ACTIVE pack with an EMPTY prize pool is the post-cutover failure mode:
  // it lists fine and 404s nothing, but every spin fails at roll time. Check the
  // pool of the pack the specs will actually open (cheapest = catalog.ts's
  // primaryPack) rather than trusting the listing.
  const cheapest = [...openable].sort((a, b) => a.price - b.price)[0]!;
  const detail = await storeGet<{ odds: unknown[] }>(
    `/store/packs/${cheapest.slug}`,
  );
  if (!detail.odds?.length) {
    throw new Error(
      `Seed preflight: pack '${cheapest.slug}' has an EMPTY prize pool — ` +
        `every open would fail. ${RESEED_HINT}.`,
    );
  }
}
