/**
 * Coverage guard for plan 061 (rate-limit sweep). This is the fourth time an
 * admin mutation route shipped without adminActionRateLimit (prior fixes:
 * plans 004, 015, 044) — this test makes the next omission fail loudly
 * instead of waiting for an audit.
 *
 * Mostly a text scan: it reads the public RATE_LIMITS table, then scans
 * middlewares.ts and every src/api/admin/**\/route.ts with regexes. No Medusa
 * framework boot and no DB.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RATE_LIMITS } from '../utils/rate-limit';
import {
  API_ROOT,
  MIDDLEWARES_PATH,
  collectRouteFiles,
  routeFileToUrl,
  mutationMethodsOf,
  matcherToRegExp,
  extractLimiterEntries,
  type LimiterEntry,
} from './rate-limit-coverage-helpers';

/**
 * Extract every `{ matcher: '...', method: ..., middlewares: [...] }` entry
 * in middlewares.ts whose middlewares array includes `adminActionRateLimit`.
 * Relies on the file's consistent field order (matcher, method, middlewares)
 * and on none of those admin-block entries nesting a `[...]` inside
 * `middlewares` (true today — verified by the entry count assertion below).
 */
function extractAdminActionRateLimitEntries(): LimiterEntry[] {
  const src = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
  const limiterName: keyof typeof RATE_LIMITS = 'admin-action';
  const bindingMatch = src.match(
    new RegExp(`const\\s+(\\w+)\\s*=\\s*rateLimit\\('${limiterName}'\\);`),
  );
  const bindingName = bindingMatch?.[1];
  if (!bindingName) return [];
  return extractLimiterEntries(src).filter((e) =>
    e.middlewares.includes(bindingName),
  );
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
      '"/admin/packs/*/odds" and "/admin/packs/*/members" siblings (verified ' +
      'empirically), multi-charging the shared admin budget on those calls. ' +
      'Needs a scoped fix before it can be added safely.',
  },
  {
    path: '/admin/packs/*',
    method: 'DELETE',
    reason:
      'Pack delete (packs/[slug]/route.ts) — same trailing-wildcard overlap as ' +
      'the POST entry above.',
  },
  // The seven below are catalog/display CRUD, not money mutations. Several
  // are driven by client-side per-row loops in shipped bulk operator tooling
  // (#299 PriceCharting collection import — a collection "can run to five
  // figures of offers"; #305 bulk retier; multi-image upload), so putting
  // them on the shared 30-request/10s burst budget would 429 mid-batch. A
  // prior audit round recorded the convention that only money-mutation
  // routes carry adminActionRateLimit; from-pricecharting is consistent with
  // its sibling CRUD routes in carrying none. Revisit only by giving them
  // their own, higher-budget limiter — never the shared admin-action one.
  {
    path: '/admin/media',
    method: 'POST',
    reason:
      'Admin image upload — multi-image upload flows fire this per-image ' +
      'from a client-side loop; the shared burst budget would 429 mid-batch.',
  },
  {
    path: '/admin/cards',
    method: 'POST',
    reason:
      'Card catalog create — catalog CRUD, not a money mutation; sibling of ' +
      'the #305 bulk-retier /admin/cards/* route below.',
  },
  {
    path: '/admin/cards/*',
    method: 'POST',
    reason:
      "Card catalog update — PR #305's bulk retier fires this per-row from a " +
      'client-side loop; the shared burst budget would 429 mid-batch.',
  },
  {
    path: '/admin/cards/*',
    method: 'DELETE',
    reason:
      'Card catalog delete — same per-row bulk-retier driver as the POST ' +
      'entry above.',
  },
  {
    path: '/admin/products/from-pricecharting',
    method: 'POST',
    reason:
      "PR #299's bulk PriceCharting collection import loops this per row " +
      '(a collection "can run to five figures of offers"); consistent with ' +
      'the recorded "only money-mutation routes carry this limiter" convention.',
  },
  {
    path: '/admin/pixel-pokemon',
    method: 'POST',
    reason:
      'Pixel-Pokemon catalog write — catalog CRUD, not a money mutation; ' +
      'unlimited per the recorded convention.',
  },
  {
    path: '/admin/packs',
    method: 'POST',
    reason:
      'Pack creation — catalog CRUD, not a money mutation (pricing/rank ' +
      'writes stay limited via reorder/odds/members); unlimited per the ' +
      'recorded convention.',
  },
  {
    path: '/admin/packs/*/top-hits',
    method: 'POST',
    reason:
      'Top Hits display-order write — display-only (never touches ' +
      'weights/locks/pricing), edited row-by-row from the admin UI; ' +
      'unlimited per the recorded convention.',
  },
];

describe('admin mutation routes are rate-limited (plan 061 coverage guard)', () => {
  const limiterEntries = extractAdminActionRateLimitEntries();
  const limiterRegexes = limiterEntries.map((e) => ({
    matcher: e.matcher,
    methods: e.methods,
    re: matcherToRegExp(e.matcher),
  }));

  it('a single `export { }` block re-exporting MULTIPLE methods detects all of them', () => {
    // Regression for the re-export alternation registering only the FIRST
    // aliased method per brace block — a synthetic source string, not a real
    // route file, keeps this text-level like the rest of the spec (no fixture
    // route.ts needed just to pin the regex).
    const synthetic = `
      export { createDeliveryOrder as POST, removeDeliveryOrder as DELETE } from './handlers';
    `;
    expect(mutationMethodsOf(synthetic).sort()).toEqual(['DELETE', 'POST']);
  });

  it('extraction is not vacuous (finds real entries, not just /store noise)', () => {
    expect(RATE_LIMITS['admin-action']).toBeDefined();
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
      'DELETE /admin/cards/*',
      'DELETE /admin/packs/*',
      'POST /admin/cards',
      'POST /admin/cards/*',
      'POST /admin/delivery-orders/*',
      'POST /admin/media',
      'POST /admin/packs',
      'POST /admin/packs/*',
      'POST /admin/packs/*/top-hits',
      'POST /admin/pixel-pokemon',
      'POST /admin/products/from-pricecharting',
    ]);
  });

  it('every admin route.ts mutation export is rate-limited or explicitly exempt', () => {
    const routeFiles = collectRouteFiles(path.join(API_ROOT, 'admin'));
    const failures: string[] = [];
    let scannedMethodCount = 0;

    for (const relPath of routeFiles) {
      const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
      const methods = mutationMethodsOf(text);
      if (methods.length === 0) continue;

      const url = routeFileToUrl(relPath);
      for (const method of methods) {
        scannedMethodCount++;
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

    // Guards MUTATION_METHOD_RE itself, the same way the extraction test above
    // guards extractAdminActionRateLimitEntries: without this floor, a regex
    // change that silently matches nothing would make `failures` vacuously
    // empty and this whole test green-for-the-wrong-reason (the axe/oklch
    // trap this file's header comment already warns about). 20 is a safe
    // floor under the measured 32 mutation-method exports as of plan 061.
    expect(scannedMethodCount).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });

  it('no route is matched by more than one adminActionRateLimit entry', () => {
    // A trailing "*" matcher (e.g. a hypothetical "/admin/packs/*" for the
    // pack-by-slug route) spans "/" (path-to-regexp 0.1.x) and can silently
    // swallow a sibling route that already has its own matcher — exactly how
    // "/admin/packs/*" and "/admin/delivery-orders/*" ended up EXEMPT instead
    // of added (see the reasons above). None of the CURRENT
    // adminActionRateLimit entries is a trailing wildcard (all are exact
    // paths or a middle "*" with a static suffix, e.g. "/admin/packs/*/odds"),
    // so nothing collides today. If a future route or matcher recreates the
    // trailing-wildcard shape, Medusa's RoutesSorter registers the
    // wildcard-bucket entry before the static one and BOTH run, double-
    // charging the shared budget for a single request. This asserts the
    // invariant directly — any route matched twice fails here, regardless of
    // which matchers are responsible — rather than relying on hand-maintained
    // code comments staying accurate.
    const routeFiles = collectRouteFiles(path.join(API_ROOT, 'admin'));
    const failures: string[] = [];

    for (const relPath of routeFiles) {
      const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
      const methods = mutationMethodsOf(text);
      if (methods.length === 0) continue;

      const url = routeFileToUrl(relPath);
      for (const method of methods) {
        const matches = limiterRegexes.filter(
          (e) => e.methods.includes(method) && e.re.test(url),
        );
        if (matches.length > 1) {
          failures.push(
            `${method} ${url} (src/api/${relPath}) matches ${matches.length} ` +
              `adminActionRateLimit entries: ${matches.map((e) => e.matcher).join(', ')} ` +
              `— would run the rate limiter more than once per request`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
