/**
 * Shared text-scan scanner behind the admin and store rate-limit coverage
 * probes (plan 061, plan 136). Mostly a text scan: it reads middlewares.ts
 * and every src/api/**\/route.ts with regexes — no Medusa framework boot and
 * no DB. Extracted from admin-rate-limit-coverage.unit.spec.ts so the store
 * probe (which uses MANY limiters, not one) can reuse the same primitives
 * instead of re-deriving them and drifting.
 */

import * as fs from 'fs';
import * as path from 'path';

export const API_ROOT = path.resolve(__dirname, '..');
export const MIDDLEWARES_PATH = path.join(API_ROOT, 'middlewares.ts');

/** Recursively collect every route.ts file under dir, relative to API_ROOT. */
export function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry.isFile() && entry.name === 'route.ts') {
      results.push(path.relative(API_ROOT, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

/**
 * `src/api/admin/packs/[slug]/odds/route.ts` -> `/admin/packs/*\/odds`.
 * Mirrors the matcher convention documented in middlewares.ts and plan 061:
 * a `[bracket]` path segment becomes a `*`.
 */
export function routeFileToUrl(relPath: string): string {
  const withoutFile = relPath.replace(/\/route\.ts$/, '');
  const segments = withoutFile
    .split('/')
    .map((seg) => (/^\[.+\]$/.test(seg) ? '*' : seg));
  return `/${segments.join('/')}`;
}

// Matches two export shapes a route.ts handler can use for a mutation
// method, so the scan can't be dodged by switching styles:
//   export async function POST(...)   (the original, still group 1)
//   export function POST(...)         (no async — group 1)
//   export const POST = ...           (arrow/const handler — group 2)
// `export { x as METHOD, y as METHOD2 }` re-exports are handled SEPARATELY
// below (RE_EXPORT_BLOCK_RE + RE_EXPORT_SPECIFIER_RE), not folded into this
// alternation: a single regex match can only capture one group per match, so
// a block aliasing more than one method at once (e.g.
// `export { create as POST, remove as DELETE }`) would silently lose every
// specifier after the first if it stayed a third alternative here.
const MUTATION_METHOD_RE =
  /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/g;

// Every `export { ... }` block, so its contents can be scanned on their own
// for however many `as METHOD` specifiers it contains.
const RE_EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}/g;
const RE_EXPORT_SPECIFIER_RE = /\bas\s+(POST|PUT|PATCH|DELETE)\b/g;

export function mutationMethodsOf(fileText: string): string[] {
  const methods = new Set<string>();

  let match: RegExpExecArray | null;
  MUTATION_METHOD_RE.lastIndex = 0;
  while ((match = MUTATION_METHOD_RE.exec(fileText))) {
    const method = match[1] || match[2];
    if (method) methods.add(method);
  }

  let blockMatch: RegExpExecArray | null;
  RE_EXPORT_BLOCK_RE.lastIndex = 0;
  while ((blockMatch = RE_EXPORT_BLOCK_RE.exec(fileText))) {
    let specMatch: RegExpExecArray | null;
    RE_EXPORT_SPECIFIER_RE.lastIndex = 0;
    while ((specMatch = RE_EXPORT_SPECIFIER_RE.exec(blockMatch[1]))) {
      methods.add(specMatch[1]);
    }
  }

  return [...methods];
}

/** GET handler exports — the sibling scan the store probe needs for public
 *  reads, which admin never had to check (no admin route is anonymous). */
const GET_METHOD_RE =
  /export\s+(?:async\s+)?function\s+GET\b|export\s+const\s+GET\s*=/g;

export function getMethodsOf(fileText: string): boolean {
  GET_METHOD_RE.lastIndex = 0;
  return GET_METHOD_RE.test(fileText);
}

/**
 * Convert a middlewares.ts matcher string into the same RegExp Express /
 * path-to-regexp 0.1.x (Medusa's runtime dependency, confirmed installed at
 * packages/api/node_modules/path-to-regexp@0.1.13) would build for it: `*`
 * spans `/` (becomes `.*`), everything else is a literal, anchored ^...$.
 * Verified against the real path-to-regexp output for this repo's matchers
 * during plan 061 (e.g. `/admin/packs/*` DOES match `/admin/packs/reorder`
 * and `/admin/packs/bronze/odds` — see the EXEMPT entries in the admin spec).
 */
export function matcherToRegExp(matcher: string): RegExp {
  const escaped = matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.split('*').join('.*');
  return new RegExp(`^${pattern}$`);
}

export interface LimiterEntry {
  matcher: string;
  methods: string[];
  /** The raw text inside the entry's `middlewares: [...]` array. */
  middlewares: string;
}

export function parseMethodField(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

/** Every HTTP method this scanner tracks — what a `method`-less entry is
 *  taken to match (see ENTRY_RE below). */
export const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Relies on the file's consistent field order (matcher, [method,] middlewares).
// `method:` is OPTIONAL — omitting it is a real, common pattern on the store
// side (e.g. `/store/vault`, `/store/credits`, `/store/leaderboard/me`: an
// exact matcher for a route that only exports one HTTP method, so the field
// is dropped rather than restated) and several of those entries DO carry a
// real limiter. The one method-less entry that carries NO limiter — the
// blanket `/store/*` catch-all — is excluded by `isLimited` finding no bound
// or inline `rateLimit(...)` name in its middlewares text, not by dropping
// method-less entries structurally (an earlier version of this scanner did
// that, which is correct only by coincidence for the ADMIN prefix, where
// every admin mutation matcher happens to declare `method:` explicitly and
// the store prefix's method-less-but-limited entries never come up).
//
// The middlewares capture allows ONE level of bracket nesting
// ((?:[^\[\]]|\[[^\[\]]*\])*) — plain `[adminActionRateLimit]` needs none,
// but every store entry that opens with `authenticate('customer',
// ['bearer'])` nests an array one level inside the outer middlewares array.
// A bare `[^\]]*` (the admin-only shape this regex started as) stops at that
// inner `]` and silently drops the entry — caught by plan 136's store probe,
// which is the first user of this scanner with nested-bracket entries.
//
// Comment lines can sit between ANY two fields, not just before `matcher:`
// (the admin-only shape again — e.g. `/store/customers/me/delete` has a
// 5-line comment between `method: 'POST',` and `middlewares:`). CGAP is that
// same optional-comment-run allowed at every field boundary.
const CGAP = '\\s*(?:\\/\\/[^\\n]*\\n\\s*)*';
const ENTRY_RE = new RegExp(
  `\\{${CGAP}matcher:\\s*'([^']+)',${CGAP}(?:method:\\s*(\\[[^\\]]*\\]|'[^']*'),${CGAP})?middlewares:\\s*\\[((?:[^[\\]]|\\[[^[\\]]*\\])*)\\],?${CGAP}\\}`,
  'g',
);

/** Every `{ matcher, [method,] middlewares }` entry in middlewares.ts. A
 *  `method`-less entry is returned with `methods: ALL_METHODS` (see above) —
 *  whether it actually carries a limiter is `isLimited`'s job, not this
 *  extractor's. */
export function extractLimiterEntries(src: string): LimiterEntry[] {
  const entries: LimiterEntry[] = [];
  let match: RegExpExecArray | null;
  ENTRY_RE.lastIndex = 0;
  while ((match = ENTRY_RE.exec(src))) {
    const [, matcher, methodRaw, middlewaresRaw] = match;
    entries.push({
      matcher,
      methods: methodRaw ? parseMethodField(methodRaw) : ALL_METHODS,
      middlewares: middlewaresRaw,
    });
  }
  return entries;
}

const BINDING_RE = /const\s+(\w+)\s*=\s*rateLimit\('[^']+'\)/g;

/** Names bound as `const X = rateLimit('…')` in the file. */
export function limiterBindings(src: string): Set<string> {
  const bindings = new Set<string>();
  let match: RegExpExecArray | null;
  BINDING_RE.lastIndex = 0;
  while ((match = BINDING_RE.exec(src))) {
    bindings.add(match[1]);
  }
  return bindings;
}

const INLINE_RATE_LIMIT_RE = /\brateLimit\(\s*'[^']*'\s*\)/;

/** True when an entry's middlewares text names a bound limiter or calls
 *  rateLimit('…') inline. */
export function isLimited(entry: LimiterEntry, bindings: Set<string>): boolean {
  if (INLINE_RATE_LIMIT_RE.test(entry.middlewares)) return true;
  for (const name of bindings) {
    if (new RegExp(`\\b${name}\\b`).test(entry.middlewares)) return true;
  }
  return false;
}
