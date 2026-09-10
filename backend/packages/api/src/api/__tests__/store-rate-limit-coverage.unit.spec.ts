/**
 * Store-side twin of admin-rate-limit-coverage.unit.spec.ts (plan 136,
 * follow-up #6 from the 2026-09-02 review). The admin probe cannot see a
 * dropped store limiter — #547/#538/#557 added three new public store
 * routes, one of which (`/store/pulls/gaps`) shipped with no limiter. This
 * walks every `src/api/store/**\/route.ts`, and asserts:
 *
 *  - every MUTATION export (POST/PUT/PATCH/DELETE) is matched by a limiter
 *    entry in middlewares.ts or sits on an explicit, exact-set MUTATION_EXEMPT
 *    list;
 *  - every GET export is likewise limited or sits on an explicit, exact-set
 *    GET_EXEMPT list with a reason.
 *
 * Unlike the admin probe (one limiter, `adminActionRateLimit`), the store
 * side uses MANY limiters bound as consts (storeReadRateLimit,
 * taskActionRateLimit, authRateLimit, …) and inline (`rateLimit('profile-read')`,
 * `rateLimit('referral-bind')`, …), so coverage here means "matched by ANY
 * known rateLimit(...) call" (rate-limit-coverage-helpers.isLimited), not one
 * named binding.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  API_ROOT,
  MIDDLEWARES_PATH,
  collectRouteFiles,
  routeFileToUrl,
  mutationMethodsOf,
  getMethodsOf,
  matcherToRegExp,
  extractLimiterEntries,
  limiterBindings,
  isLimited,
} from './rate-limit-coverage-helpers';

const STORE_ROOT = path.join(API_ROOT, 'store');

const middlewaresSrc = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
const bindings = limiterBindings(middlewaresSrc);
// Scoped to /store matchers only — extractLimiterEntries returns every
// prefix in the file (/admin, /auth, /hooks, /vendor too), and coverage
// matching only needs the store ones. The blanket `/store/*` entry IS
// included here (method-less, matched by matcherToRegExp against a store
// URL); it stays a non-limiter because `isLimited` finds neither a bound nor
// an inline rateLimit(...) name in its middlewares text — see the next test.
const limiterEntries = extractLimiterEntries(middlewaresSrc).filter((e) =>
  e.matcher.startsWith('/store'),
);
const limiterRegexes = limiterEntries.map((e) => ({
  ...e,
  re: matcherToRegExp(e.matcher),
  limited: isLimited(e, bindings),
}));

function isRouteLimited(url: string, method: string): boolean {
  return limiterRegexes.some(
    (e) => e.limited && e.methods.includes(method) && e.re.test(url),
  );
}

// Every store route.ts's mutation exports were audited against middlewares.ts
// at 1bc30e6b (plan 136 drift check) and every one is matched by its own
// limiter entry — see the plan's table. Kept EXACT-SET asserted, exactly like
// the admin probe's EXEMPT list, so a future omission (the `gaps` pattern)
// fails loudly here instead of at the next audit.
const MUTATION_EXEMPT: { path: string; method: string; reason: string }[] = [];

// Public (no customer auth required), no-limiter GET routes that ARE
// genuinely protected by a per-process cache — exact-set asserted. Populated
// from the plan's round-15 candidate list, RE-VERIFIED by reading each route
// (the plan's own rule: "verify the cache claim by reading each route before
// writing its reason"). Three of the original nine candidates
// (cards/*, pricing/fx, avatar-frames) turned out to have NO cache on
// inspection — the plan's rule for that case is explicit ("a route without a
// cache goes on the report, not the list"), so they are NOT here; see
// KNOWN_UNPROTECTED_GETS below and the completion report.
const GET_EXEMPT: { path: string; reason: string }[] = [
  {
    path: '/store/pulls/gaps',
    reason:
      'plan 134 adds storeReadRateLimit to this matcher; remove this entry when it lands. Cached per-process 5s (CACHE_TTL_MS, pulls/gaps/route.ts) in the meantime.',
  },
  {
    path: '/store/pulls/recent',
    reason:
      'cached per-process 5s (CACHE_TTL_MS, pulls/recent/route.ts); a miss costs one indexed read.',
  },
  {
    path: '/store/leaderboard',
    reason:
      'cached per-process 30s (CACHE_TTL_MS, leaderboard/route.ts); a miss costs a whole-board aggregate.',
  },
  {
    path: '/store/packs',
    reason:
      'cached per-process 30s (CACHE_TTL_MS, packs/route.ts); a miss costs one indexed read.',
  },
  {
    path: '/store/packs/*',
    reason:
      'cached per-process 30s, keyed by slug (CACHE_TTL_MS, packs/[slug]/route.ts); a miss costs one indexed read.',
  },
  {
    path: '/store/challenge',
    reason:
      'cached per-process 30s (CACHE_TTL_MS, challenge/route.ts); a miss costs two whole-table scans.',
  },
];

// FINDING (plan 136, not fixed by this plan — out of scope per the plan's
// "Adding limiters to the cached public GETs" exclusion, which by extension
// covers adding one to an UNCACHED public GET too; that needs its own sizing
// pass). These three of the round-15 audit's nine GET candidates are public,
// anonymous, and have NEITHER a limiter NOR a cache — verified by reading
// each route, not assumed:
//   - /store/cards/*        (cards/[handle]/route.ts): live listCards +
//     bestLiveTierByHandle + listCardPriceHistories reads every call. Only
//     its FX-rate sub-value benefits from pricing.ts's shared 30s
//     fxDisplayCache (via resolveFxRate); nothing else is memoized.
//   - /store/pricing/fx     (pricing/fx/route.ts): calls resolveFxRateInfo
//     directly, which does NOT check fxDisplayCache — only the sibling
//     resolveFxRate wrapper does (pricing.ts:120-127). Zero caching.
//   - /store/avatar-frames  (avatar-frames/route.ts): PacksModuleService
//     .siteSettings() is a live, unmemoized DB read.
// They are deliberately NOT on GET_EXEMPT (writing "cached" would be false)
// and NOT given a limiter (out of scope here — a store-read budget on a
// catalog/pricing route needs its own sizing pass, the same reasoning the
// plan gives for not touching the cached ones).
//
// This list is a RECORDED FINDING, not an exemption. The GET-coverage test
// below pins it as an EXACT SET, which keeps the guard loud in BOTH
// directions:
//   - a NEW unlimited, uncached GET route fails the test BY NAME (it shows up
//     in the received set) — the `/store/pulls/gaps` regression this whole
//     probe exists to catch;
//   - giving one of these three a real limiter (or a cache plus a GET_EXEMPT
//     entry) ALSO fails the test, until the route is deleted from this list —
//     so a fix cannot land without updating the finding.
// The test is a plain `it`, never an expected-to-fail wrapper: such a wrapper
// reports a body that fails for a BRAND-NEW reason as a pass, which is exactly
// the silent regression being guarded against.
const KNOWN_UNPROTECTED_GETS = [
  '/store/cards/*',
  '/store/pricing/fx',
  '/store/avatar-frames',
];

describe('store routes are rate-limited (plan 136 coverage guard)', () => {
  it('extraction is not vacuous', () => {
    expect(bindings.has('storeReadRateLimit')).toBe(true);
    expect(limiterEntries.length).toBeGreaterThan(30);
    expect(
      limiterEntries.some((e) => e.matcher === '/store/packs/*/open'),
    ).toBe(true);
    expect(limiterEntries.every((e) => !e.matcher.startsWith('/admin'))).toBe(
      true,
    );
  });

  it('the /store/* blanket entry is never counted as coverage', () => {
    // Unlike the admin probe (which never sees a method-less entry that DOES
    // carry a limiter — every admin mutation matcher declares `method:`
    // explicitly), the store side has several real method-less-but-limited
    // entries (`/store/vault`, `/store/credits`, `/store/leaderboard/me`, …),
    // so extractLimiterEntries returns them all, methods defaulted to
    // ALL_METHODS. The ONE method-less entry with no limiter — the blanket
    // `/store/*` (noStoreForAuthenticatedStore + blockDisabledCustomerSession)
    // — must still never read as covered: isLimited finds neither a bound
    // nor an inline rateLimit(...) name in its middlewares text.
    const blanket = limiterEntries.find((e) => e.matcher === '/store/*');
    expect(blanket).toBeDefined();
    expect(isLimited(blanket!, bindings)).toBe(false);
  });

  it('the MUTATION_EXEMPT list is exactly what plan 136 found — no silent growth', () => {
    const keys = MUTATION_EXEMPT.map((e) => `${e.method} ${e.path}`).sort();
    expect(keys).toEqual([]);
  });

  it('the GET_EXEMPT list is exactly what plan 136 found — no silent growth', () => {
    const keys = GET_EXEMPT.map((e) => e.path).sort();
    expect(keys).toEqual(
      [
        '/store/challenge',
        '/store/leaderboard',
        '/store/packs',
        '/store/packs/*',
        '/store/pulls/gaps',
        '/store/pulls/recent',
      ].sort(),
    );
  });

  it('KNOWN_UNPROTECTED_GETS is exactly the three finding routes — no silent growth', () => {
    expect([...KNOWN_UNPROTECTED_GETS].sort()).toEqual(
      ['/store/avatar-frames', '/store/cards/*', '/store/pricing/fx'].sort(),
    );
  });

  it('every store route.ts mutation export is rate-limited or explicitly exempt', () => {
    const routeFiles = collectRouteFiles(STORE_ROOT);
    const failures: string[] = [];
    let scannedMethodCount = 0;

    for (const relPath of routeFiles) {
      const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
      const methods = mutationMethodsOf(text);
      if (methods.length === 0) continue;

      const url = routeFileToUrl(relPath);
      for (const method of methods) {
        scannedMethodCount++;
        const covered = isRouteLimited(url, method);
        const exempt = MUTATION_EXEMPT.some(
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
            `${method} ${url} is both covered by a limiter matcher AND ` +
              `listed in MUTATION_EXEMPT — remove the stale entry`,
          );
        }
      }
    }

    // Same green-for-the-wrong-reason guard as the admin probe: without this
    // floor, a regex change that silently matches nothing would leave
    // `failures` vacuously empty.
    expect(scannedMethodCount).toBeGreaterThan(25);
    expect(failures).toEqual([]);
  });

  // A plain `it` that pins the finding as an exact set — see
  // KNOWN_UNPROTECTED_GETS above for the read-the-route evidence behind the
  // three names, and for why the exact-set shape is loud in both directions.
  // The two failure modes are kept in SEPARATE arrays on purpose: `stale`
  // (covered AND exempt) must always be empty, while `failures` (neither
  // covered nor exempt) must equal the recorded finding — collapsing them
  // would let a stale GET_EXEMPT entry masquerade as one of the three.
  it('every store route.ts GET export is rate-limited, on GET_EXEMPT, or one of the KNOWN_UNPROTECTED_GETS findings — exact set', () => {
    const routeFiles = collectRouteFiles(STORE_ROOT);
    const failures: string[] = [];
    const stale: string[] = [];
    let scannedGetCount = 0;

    for (const relPath of routeFiles) {
      const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
      if (!getMethodsOf(text)) continue;
      scannedGetCount++;

      const url = routeFileToUrl(relPath);
      const covered = isRouteLimited(url, 'GET');
      const exempt = GET_EXEMPT.some((e) => e.path === url);

      // The bare URL, not a decorated sentence: this array is compared to
      // KNOWN_UNPROTECTED_GETS as a set, and the array diff names the
      // offending route on its own.
      if (!covered && !exempt) {
        failures.push(url);
      }
      if (covered && exempt) {
        stale.push(
          `GET ${url} is both covered by a limiter matcher AND listed in ` +
            `GET_EXEMPT — remove the stale entry`,
        );
      }
    }

    // Same green-for-the-wrong-reason guard as the mutation test: without this
    // floor, a helper regression that matched no route files would make both
    // assertions below vacuous.
    expect(scannedGetCount).toBeGreaterThan(20);
    expect(stale).toEqual([]);
    expect([...failures].sort()).toEqual([...KNOWN_UNPROTECTED_GETS].sort());
  });
});

describe('rate-limit-coverage-helpers regression tests (regex shapes that silently under-reported before plan 136)', () => {
  // Guards against re-simplifying ENTRY_RE back to admin-only shapes. Each
  // one is a real entry shape from middlewares.ts that the ORIGINAL
  // admin-derived regex silently dropped (verified empirically while
  // building the store probe — entries.length stayed "> 30" even while every
  // one of these was missing, so a length floor alone does not catch this).
  it("captures an entry whose middlewares array nests a bracket (authenticate(..., ['bearer']))", () => {
    const synthetic = `
      export const middlewares = [
        {
          matcher: '/store/example',
          method: 'POST',
          middlewares: [
            authenticate('customer', ['bearer']),
            rateLimit('example'),
          ],
        },
      ];
    `;
    const entries = extractLimiterEntries(synthetic);
    const entry = entries.find((e) => e.matcher === '/store/example');
    expect(entry).toBeDefined();
    expect(entry!.middlewares).toContain("rateLimit('example')");
  });

  it('captures a method-less entry and defaults its methods to ALL_METHODS', () => {
    const synthetic = `
      export const middlewares = [
        {
          matcher: '/store/example-read',
          middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
        },
      ];
    `;
    const entries = extractLimiterEntries(synthetic);
    const entry = entries.find((e) => e.matcher === '/store/example-read');
    expect(entry).toBeDefined();
    expect(entry!.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    );
  });

  it('captures an entry with a comment block between `method:` and `middlewares:`', () => {
    const synthetic = `
      export const middlewares = [
        {
          matcher: '/store/example-delete',
          method: 'POST',
          // A multi-line comment sitting between the method and middlewares
          // fields, the exact shape /store/customers/me/delete has.
          middlewares: [
            authenticate('customer', ['bearer']),
            rateLimit('example-delete'),
          ],
        },
      ];
    `;
    const entries = extractLimiterEntries(synthetic);
    const entry = entries.find((e) => e.matcher === '/store/example-delete');
    expect(entry).toBeDefined();
    expect(entry!.middlewares).toContain("rateLimit('example-delete')");
  });
});
