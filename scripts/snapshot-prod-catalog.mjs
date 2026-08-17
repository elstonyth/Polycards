#!/usr/bin/env node
// snapshot-prod-catalog — pull the LIVE production catalog (packs + their prize
// pools) and write it as the E2E fixture data module the local/CI seed installs.
//
// Why: the E2E fixture used to invent its own packs ('pokemon-rookie',
// 'pokemon-elite') and cards ('PW Pikachu'), so every test ran against a catalog
// that shares nothing with production — different slugs, different prices,
// different rarity mix. Bugs that only show up on the real catalog were
// untestable, and reading a test told you nothing about the real storefront.
//
// Source: the PUBLIC storefront pages. /slots carries the pack list and
// /slots/<slug> carries that pack's resolved pool, both embedded in the RSC
// flight payload. No credentials, no admin API, no DB access — this script only
// GETs pages any visitor can load, and it NEVER writes to production.
//
// Run (from the repo root, whenever the prod catalog changes):
//   node scripts/snapshot-prod-catalog.mjs
//   node scripts/snapshot-prod-catalog.mjs --per-pack 40 --base https://polycards.gg
//
// Output: backend/packages/api/src/scripts/prod-catalog.data.ts (a .ts module,
// not JSON, so `medusa exec` compiles it in like vip-levels.data.ts — no runtime
// file reads and no build-copy step to forget).

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(
  HERE,
  '../backend/packages/api/src/scripts/prod-catalog.data.ts',
);

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const BASE = (argOf('--base', 'https://polycards.gg') ?? '').replace(/\/$/, '');
// Cap the pool we mirror per pack. Prod pools run to hundreds of cards; the
// suite needs a faithful MIX (every rarity tier present, real names/prices/art),
// not the whole inventory — and a 1,000-row seed makes every CI run slower for
// nothing. Rarest-first selection keeps the tail tiers that matter.
const PER_PACK = Number(argOf('--per-pack', '30'));

// Rarest first — mirrors RARITIES in @acme/odds-math. Used to bias the sample so
// a capped pool still contains the rare tiers (which is where the interesting
// odds/pricing behaviour lives).
const RARITY_ORDER = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
];

const get = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'polycards-snapshot' },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
};

/** Concatenate the RSC flight payload out of the `self.__next_f.push([1,"…"])`
 *  chunks. Each chunk is a JSON string literal, so JSON.parse un-escapes it. */
function flightText(html) {
  let out = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      out += JSON.parse(m[1]);
    } catch {
      /* a chunk we can't parse is a chunk we don't need */
    }
  }
  return out;
}

/** Parse the JSON array that starts at `text[start]` ('['), by bracket matching
 *  (the payload is one long line, so a regex can't find the end reliably). */
function parseArrayAt(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unterminated array in flight payload');
}

/** First `"<key>":[ … ]` array in the payload, or null when the key is absent. */
function arrayField(text, key) {
  const at = text.indexOf(`"${key}":[`);
  if (at === -1) return null;
  return parseArrayAt(text, text.indexOf('[', at));
}

/** "RM 10,786.99" -> 10786.99 */
const parseMyr = (value) => {
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Prod card handles encode the grade, e.g. `rowlet-290-sm-p-psa-10-4683337`.
 *  That is the only public source for grader/grade, and both drive real
 *  behaviour (Card.grader decides GRADED vs RAW, PSA 10 drives the guarantee
 *  badge), so parse them rather than inventing a value. */
function gradeOf(handle) {
  // …-psa-10-4683337 → PSA 10 · …-psa-9-5-4683337 → PSA 9.5. The trailing group
  // is the PriceCharting product id, NOT part of the grade — anchor on the end
  // so it can't be swallowed into the grade (it was, before this anchor).
  const m = /-(psa|bgs|cgc|ace|tag)-(\d{1,2})(-5)?-\d+$/i.exec(handle);
  if (!m) return { grader: '', grade: '' };
  return { grader: m[1].toUpperCase(), grade: m[3] ? `${m[2]}.5` : m[2] };
}

/** Card set, best-effort from the printed number suffix ("#290/SM-P" -> SM-P).
 *  Display-only in the fixture; no test asserts on it. */
function setOf(name) {
  const m = /#[^/\s]*\/([A-Za-z0-9-]+)/.exec(name ?? '');
  return m ? m[1].toUpperCase() : 'Prod Snapshot';
}

/** STRATIFIED sample: keep prod's tier PROPORTIONS, with >=1 of every tier the
 *  real pool contains. A plain rarest-first cut looked thorough but inverted the
 *  mix (16 of 30 bronze cards Immortal, where prod bronze is mostly Common) —
 *  and the tier mix is what pull odds, buyback value and RTP are computed from,
 *  so a skewed sample builds a fixture that lies about the economy. */
function samplePool(pool, cap) {
  if (pool.length <= cap) return pool;
  const byTier = new Map();
  for (const c of pool) {
    const tier = RARITY_ORDER.includes(c.rarity) ? c.rarity : 'Common';
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(c);
  }
  // Within a tier take the most valuable — the cards Top Hits actually shows.
  for (const list of byTier.values()) {
    list.sort((a, b) => parseMyr(b.value) - parseMyr(a.value));
  }
  const tiers = RARITY_ORDER.filter((t) => byTier.has(t));
  const quota = new Map(tiers.map((t) => [t, 1])); // floor: never lose a tier
  let left = cap - tiers.length;
  for (const t of tiers) {
    if (left <= 0) break;
    const share = Math.min(
      left,
      Math.round((byTier.get(t).length / pool.length) * (cap - tiers.length)),
      byTier.get(t).length - 1,
    );
    if (share > 0) {
      quota.set(t, quota.get(t) + share);
      left -= share;
    }
  }
  // Rounding leftovers go to the biggest tiers first (the realistic bulk).
  for (const t of [...tiers].sort(
    (a, b) => byTier.get(b).length - byTier.get(a).length,
  )) {
    if (left <= 0) break;
    const add = Math.min(
      left,
      Math.max(0, byTier.get(t).length - quota.get(t)),
    );
    quota.set(t, quota.get(t) + add);
    left -= add;
  }
  return tiers.flatMap((t) => byTier.get(t).slice(0, quota.get(t)));
}

async function main() {
  console.log(`[snapshot] source: ${BASE} (read-only)`);

  const listing = flightText(await get(`${BASE}/slots`));
  const packs = arrayField(listing, 'packs');
  if (!packs?.length) {
    throw new Error(
      `no packs found in ${BASE}/slots — the storefront markup changed; ` +
        'update flightText/arrayField in this script.',
    );
  }
  console.log(
    `[snapshot] ${packs.length} live pack(s): ${packs.map((p) => p.id).join(', ')}`,
  );

  const cards = new Map(); // handle -> card (deduped across packs)
  const packRows = [];

  for (const pack of packs) {
    const detail = flightText(await get(`${BASE}/slots/${pack.id}`));
    const pool = arrayField(detail, 'pool') ?? [];
    const sampled = samplePool(pool, PER_PACK);
    console.log(
      `[snapshot]   ${pack.id}: pool ${pool.length} -> ${sampled.length} sampled`,
    );

    for (const c of sampled) {
      if (!cards.has(c.id)) {
        const { grader, grade } = gradeOf(c.id);
        cards.set(c.id, {
          handle: c.id,
          name: c.name,
          set: setOf(c.name),
          grader,
          grade,
          // Prod exposes the DISPLAYED price (usd × fx × multiplier). The seed
          // divides it back out with the same fx + multiplier it installs, so a
          // local card renders the exact RM figure production shows.
          display_myr: parseMyr(c.value),
          image: c.image ?? '',
          slab_image: c.slabImage ?? null,
          pokemon_dex: typeof c.pokemonDex === 'number' ? c.pokemonDex : null,
          sprite_image: c.spriteImage ?? null,
        });
      }
    }

    packRows.push({
      slug: pack.id,
      title: pack.name,
      price: pack.priceValue,
      buyback_percent: pack.buybackPercent ?? 90,
      image: pack.image,
      display_image: pack.displayImage ?? null,
      rank: packRows.length,
      cards: sampled.map((c) => ({ handle: c.id, rarity: c.rarity })),
    });
  }

  const banner = `// GENERATED by scripts/snapshot-prod-catalog.mjs — do not hand-edit.
// A read-only snapshot of the LIVE production catalog (${BASE}), taken so the
// E2E suite exercises the real packs and real cards instead of invented ones.
// Re-run the script after an operator changes the prod catalog.
//
// Cards carry \`display_myr\` (the RM figure prod shows), not raw USD FMV: the
// public storefront only exposes the displayed price. seed-e2e-fixtures.ts
// converts it back with the same FX rate + multiplier it seeds, so a locally
// seeded card renders the same RM as production.
`;

  const body = `${banner}
export interface ProdCatalogCard {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  display_myr: number;
  image: string;
  slab_image: string | null;
  pokemon_dex: number | null;
  sprite_image: string | null;
}

export interface ProdCatalogPack {
  slug: string;
  title: string;
  price: number;
  buyback_percent: number;
  image: string;
  display_image: string | null;
  rank: number;
  cards: { handle: string; rarity: string }[];
}

/** ISO timestamp of the snapshot, for staleness triage. */
export const PROD_CATALOG_CAPTURED_AT = ${JSON.stringify(new Date().toISOString())};
export const PROD_CATALOG_SOURCE = ${JSON.stringify(BASE)};

export const PROD_CARDS: ProdCatalogCard[] = ${JSON.stringify([...cards.values()], null, 2)};

export const PROD_PACKS: ProdCatalogPack[] = ${JSON.stringify(packRows, null, 2)};
`;

  writeFileSync(OUT, body, 'utf8');
  console.log(
    `[snapshot] wrote ${OUT}\n[snapshot] ${packRows.length} packs, ${cards.size} unique cards`,
  );
}

main().catch((err) => {
  console.error(`[snapshot] FAILED: ${err.message}`);
  process.exit(1);
});
