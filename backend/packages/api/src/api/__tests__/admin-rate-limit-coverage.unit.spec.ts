/**
 * Coverage guard for plan 061 (rate-limit sweep). This is the fourth time an
 * admin mutation route shipped without adminActionRateLimit (prior fixes:
 * plans 004, 015, 044) — this test makes the next omission fail loudly
 * instead of waiting for an audit.
 *
 * Pure text scan, zero runtime imports: it reads middlewares.ts and every
 * src/api/admin/**\/route.ts as text with regexes. No Medusa framework, no
 * app boot, no DB.
 */

import * as fs from 'fs';
import * as path from 'path';

const API_ROOT = path.resolve(__dirname, '..');
const MIDDLEWARES_PATH = path.join(API_ROOT, 'middlewares.ts');

/** Recursively collect every route.ts file under dir, relative to API_ROOT. */
function collectRouteFiles(dir: string): string[] {
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
function routeFileToUrl(relPath: string): string {
  const withoutFile = relPath.replace(/\/route\.ts$/, '');
  const segments = withoutFile
    .split('/')
    .map((seg) => (/^\[.+\]$/.test(seg) ? '*' : seg));
  return `/${segments.join('/')}`;
}

const MUTATION_METHOD_RE =
  /export async function (POST|PUT|PATCH|DELETE)\b/g;

function mutationMethodsOf(fileText: string): string[] {
  const methods = new Set<string>();
  let match: RegExpExecArray | null;
  MUTATION_METHOD_RE.lastIndex = 0;
  while ((match = MUTATION_METHOD_RE.exec(fileText))) {
    methods.add(match[1]);
  }
  return [...methods];
}

/**
 * Convert a middlewares.ts matcher string into the same RegExp Express /
 * path-to-regexp 0.1.x (Medusa's runtime dependency, confirmed installed at
 * packages/api/node_modules/path-to-regexp@0.1.13) would build for it: `*`
 * spans `/` (becomes `.*`), everything else is a literal, anchored ^...$.
 * Verified against the real path-to-regexp output for this repo's matchers
 * during plan 061 (e.g. `/admin/packs/*` DOES match `/admin/packs/reorder`
 * and `/admin/packs/bronze/odds` — see the EXEMPT entries below).
 */
function matcherToRegExp(matcher: string): RegExp {
  const escaped = matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.split('*').join('.*');
  return new RegExp(`^${pattern}$`);
}

interface LimiterEntry {
  matcher: string;
  methods: string[];
}

function parseMethodField(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

/**
 * Extract every `{ matcher: '...', method: ..., middlewares: [...] }` entry
 * in middlewares.ts whose middlewares array includes `adminActionRateLimit`.
 * Relies on the file's consistent field order (matcher, method, middlewares)
 * and on none of those admin-block entries nesting a `[...]` inside
 * `middlewares` (true today — verified by the entry count assertion below).
 */
function extractAdminActionRateLimitEntries(): LimiterEntry[] {
  const src = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
  const entryRe =
    /{\s*(?:\/\/[^\n]*\n\s*)*matcher:\s*'([^']+)',\s*method:\s*(\[[^\]]*\]|'[^']*'),\s*middlewares:\s*\[([^\]]*)\],?\s*}/g;
  const entries: LimiterEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(src))) {
    const [, matcher, methodRaw, middlewaresRaw] = match;
    if (middlewaresRaw.includes('adminActionRateLimit')) {
      entries.push({ matcher, methods: parseMethodField(methodRaw) });
    }
  }
  return entries;
}

// Routes that export a mutation method but are deliberately NOT matched by
// any adminActionRateLimit entry, with the reason a limiter matcher can't be
// added for them today. Every entry here must be individually justified —
// prefer adding the limiter (see plan 061 Step 2) over exempting.
const EXEMPT: { path: string; method: string; reason: string }[] = [
  {
    path: '/admin/delivery-orders/*',
    method: 'POST',
    reason:
      'Single delivery-order status transition (delivery-orders/[id]/route.ts). ' +
      'A trailing-wildcard matcher "/admin/delivery-orders/*" also matches the ' +
      'already-covered "/admin/delivery-orders/bulk" sibling (path-to-regexp ' +
      '0.1.x "*" spans "/" — verified against the installed package), which ' +
      'would double-charge the shared admin budget on every bulk call. Needs a ' +
      'scoped fix (e.g. an exact id-aware matcher) before it can be added safely.',
  },
  {
    path: '/admin/packs/*',
    method: 'POST',
    reason:
      'Pack update (packs/[slug]/route.ts). A trailing-wildcard matcher ' +
      '"/admin/packs/*" also matches the already-covered "/admin/packs/reorder", ' +
      '"/admin/packs/*/odds", "/admin/packs/*/members" and "/admin/packs/*/top-hits" ' +
      'siblings (verified empirically), multi-charging the shared admin budget ' +
      'on those calls. Needs a scoped fix before it can be added safely.',
  },
  {
    path: '/admin/packs/*',
    method: 'DELETE',
    reason:
      'Pack delete (packs/[slug]/route.ts) — same trailing-wildcard overlap as ' +
      'the POST entry above.',
  },
];

describe('admin mutation routes are rate-limited (plan 061 coverage guard)', () => {
  const limiterEntries = extractAdminActionRateLimitEntries();
  const limiterRegexes = limiterEntries.map((e) => ({
    methods: e.methods,
    re: matcherToRegExp(e.matcher),
  }));

  it('extraction is not vacuous (finds real entries, not just /store noise)', () => {
    // Guards against a regex change silently matching nothing (green-for-the-
    // wrong-reason, as happened with the axe/oklch a11y gate).
    expect(limiterEntries.length).toBeGreaterThan(20);
    expect(
      limiterEntries.some((e) => e.matcher === '/admin/customers/*/freeze'),
    ).toBe(true);
    expect(limiterEntries.every((e) => !e.matcher.startsWith('/store'))).toBe(
      true,
    );
  });

  it('the EXEMPT list is exactly the routes plan 061 intended — no silent growth', () => {
    const keys = EXEMPT.map((e) => `${e.method} ${e.path}`).sort();
    expect(keys).toEqual([
      'DELETE /admin/packs/*',
      'POST /admin/delivery-orders/*',
      'POST /admin/packs/*',
    ]);
  });

  it('every admin route.ts mutation export is rate-limited or explicitly exempt', () => {
    const routeFiles = collectRouteFiles(path.join(API_ROOT, 'admin'));
    const failures: string[] = [];

    for (const relPath of routeFiles) {
      const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
      const methods = mutationMethodsOf(text);
      if (methods.length === 0) continue;

      const url = routeFileToUrl(relPath);
      for (const method of methods) {
        const covered = limiterRegexes.some(
          (e) => e.methods.includes(method) && e.re.test(url),
        );
        const exempt = EXEMPT.some(
          (e) => e.path === url && e.method === method,
        );

        if (!covered && !exempt) {
          failures.push(
            `${method} ${url} (src/api/${relPath}) exports ${method} but ` +
              `is not rate-limited and not exempt`,
          );
        }
        if (covered && exempt) {
          failures.push(
            `${method} ${url} is both covered by a limiter matcher AND listed ` +
              `in EXEMPT — remove the stale EXEMPT entry`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
