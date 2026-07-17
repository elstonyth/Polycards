// pokemontcg.io lookup for graded-slab label prefill (spec §7a): a release
// year is an objective fact and PSA's Variety is usually the rarity, so both
// prefill the admin form — but stay operator-overridable, and this NEVER
// feeds the bake path directly. EN only: pokemontcg.io has zero Japanese
// coverage. Set data is immutable once released → cache success forever;
// failures are NOT cached so a transient outage degrades to manual entry,
// not a permanently-empty prefill.
const TCG_API = 'https://api.pokemontcg.io/v2';
const TIMEOUT_MS = 5_000;

export type TcgCardMeta = { year: string | null; note: string | null };

export function pcSetToTcgName(consoleName: string): string | null {
  const stripped = consoleName.trim().replace(/^Pokemon\s+/i, '');
  if (stripped === '' || /^Japanese\b/i.test(stripped)) return null;
  return stripped;
}

type TcgSet = { id: string; name: string; releaseDate?: string };

const setCache = new Map<string, TcgSet>();
const cardCache = new Map<string, string | null>(); // set.id:number → rarity

const getJson = async (url: string): Promise<unknown | null> => {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return null;
    return (await resp.json()) as unknown;
  } catch {
    return null;
  }
};

export async function fetchTcgCardMeta(
  consoleName: string,
  number: string,
): Promise<TcgCardMeta> {
  const none: TcgCardMeta = { year: null, note: null };
  const setName = pcSetToTcgName(consoleName);
  if (!setName) return none;

  const setKey = setName.toLowerCase();
  let set = setCache.get(setKey) ?? null;
  if (!set) {
    // Mechanical match, not fuzzy (§7a): exact name equality after the prefix
    // strip; a miss means "unknown set", never a guess. A double-quote in the
    // input would close the Lucene phrase and inject extra clauses — strip it
    // (no real set name has one; the exact-match find below then just misses).
    const json = await getJson(
      `${TCG_API}/sets?q=${encodeURIComponent(`name:"${setName.replace(/"/g, '')}"`)}`,
    );
    const sets = (json as { data?: TcgSet[] } | null)?.data;
    if (!sets) return none; // upstream failure — do not cache
    set = sets.find((s) => s.name.toLowerCase() === setKey) ?? null;
    if (set) setCache.set(setKey, set);
  }
  if (!set) return none;

  const year = set.releaseDate ? set.releaseDate.slice(0, 4) : null;
  const num = number.replace(/^#/, '').trim();
  // Unquoted Lucene term below — whitespace or specials would smuggle extra
  // query clauses. Real card numbers are alphanumeric with '/' or '-' (same
  // shape the admin page's #-suffix extractor allows); anything else → no
  // card lookup, year-only prefill.
  if (!/^[A-Za-z0-9/-]+$/.test(num)) return { year, note: null };

  const cardKey = `${set.id}:${num.toLowerCase()}`;
  if (!cardCache.has(cardKey)) {
    // Scoping by set id is required — a bare name+number query can collide
    // across sets (§7a).
    const json = await getJson(
      `${TCG_API}/cards?q=${encodeURIComponent(`set.id:${set.id} number:${num}`)}`,
    );
    const cards = (json as { data?: Array<{ rarity?: string }> } | null)?.data;
    if (!cards) return { year, note: null }; // upstream failure — do not cache
    cardCache.set(cardKey, cards[0]?.rarity ?? null);
  }
  const rarity = cardCache.get(cardKey) ?? null;
  return { year, note: rarity ? rarity.toUpperCase() : null };
}
