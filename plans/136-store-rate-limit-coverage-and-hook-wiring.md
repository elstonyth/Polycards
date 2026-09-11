# Plan 136: A `/store` twin of the admin rate-limit coverage probe, and a wiring assertion for the TGPay callback allowlist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- backend/packages/api/src/api/__tests__/ backend/packages/api/src/api/middlewares.ts backend/packages/api/src/api/utils/rate-limit.ts backend/packages/api/src/api/utils/payer-ip.ts backend/packages/api/src/api/utils/__tests__/tgpay-callback-allowlist.unit.spec.ts backend/packages/api/src/modules/packs/gateway.ts`
> Expected on a branch cut from origin/master `51f74bcd`: `middlewares.ts`
> (+52 — `/admin/players`, `/admin/players/export`,
> `/admin/customer-groups/*/policy`, `/admin/customer-groups*` entries; the
> admin probe already covers them per #576's commit body). Anything else →
> compare against "Current state"; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW — tests only; the only product decision is which public GETs go on the EXEMPT list
- **Depends on**: 134 (adds the `/store/pulls/gaps` matcher this probe would otherwise flag — land 134 first, or land this with `gaps` on EXEMPT and remove the entry when 134 merges)
- **Category**: tests / security
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; drift-checked against origin/master `51f74bcd`

## Why this matters

The admin surface cannot lose a rate limiter without CI going red:
`api/__tests__/admin-rate-limit-coverage.unit.spec.ts` walks every
`src/api/admin/**/route.ts`, extracts its mutation exports, and asserts each
is matched by an `adminActionRateLimit` entry in `middlewares.ts` or sits on
an explicit, exact-set EXEMPT list. It exists because "the omission happened
four times" (plans 004, 015, 044, 061). The **store** surface — where the
customer's money and phone verification live — has no such probe. The
2026-09-02 review named it as follow-up #6; #560 then rewrote every limiter
registration by hand in one list, and #547/#538/#557 added three new public
store routes of which one (`/store/pulls/gaps`) shipped with no limiter.
The round-15 auditor confirmed no store route _lost_ its limiter in #560 —
by reading. That is the check this plan turns into a test.

Separately, the TGPay callback allowlist — the only thing besides the
gateway's key headers standing between an anonymous POST and a money write
— is wired at exactly one place (`middlewares.ts`, `matcher: '/hooks/tgpay/*'`).
Its spec tests the middleware in isolation and never reads `middlewares.ts`.
Rename a hook path, reorder the array, or drop the entry in a refactor and
production reverts to header-only callback authentication with a green
suite.

After this plan: every `/store` mutation export is limited or explicitly
exempt (exact set, no silent growth); every public `/store` GET is limited
or explicitly exempt with a stated reason; every path under
`GATEWAYS[*].hooks` is matched by an entry carrying both the hook limiter and
the allowlist.

## Current state

### Files

- `backend/packages/api/src/api/__tests__/admin-rate-limit-coverage.unit.spec.ts` (~330 lines) — the template. Helpers: `collectRouteFiles` (20-31), `routeFileToUrl` (38-45), `mutationMethodsOf` (55-86), `matcherToRegExp` (98-102), `parseMethodField` (109-115), `extractAdminActionRateLimitEntries` (124-143), `EXEMPT` (149-236), the `describe` (238-330).
- `backend/packages/api/src/api/middlewares.ts` — the single `defineMiddlewares({ routes: [...] })` array; store block spans roughly lines 330-1270; hook entry at 297-315; blanket `/store/*` entry at ~1270.
- `backend/packages/api/src/api/utils/rate-limit.ts` — `RATE_LIMITS` table (651-1146); `rateLimit(name)` factory.
- `backend/packages/api/src/api/utils/payer-ip.ts` — `createTgpayCallbackAllowlist` (~line 85-125).
- `backend/packages/api/src/api/utils/__tests__/tgpay-callback-allowlist.unit.spec.ts` — isolated middleware tests.
- `backend/packages/api/src/modules/packs/gateway.ts` — `GATEWAYS` registry; `hooks: { deposit, withdrawal, payoutVerify? }` per gateway (type at 75; tgpay values at 98-101; fake at 130-133).

### Excerpts

How the admin probe finds limiter entries (it keys on the **binding name**
of one limiter):

```ts
// admin-rate-limit-coverage.unit.spec.ts:124-143
function extractAdminActionRateLimitEntries(): LimiterEntry[] {
  const src = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
  const limiterName: keyof typeof RATE_LIMITS = 'admin-action';
  const bindingMatch = src.match(
    new RegExp(`const\\s+(\\w+)\\s*=\\s*rateLimit\\('${limiterName}'\\);`),
  );
  const bindingName = bindingMatch?.[1];
  if (!bindingName) return [];
  const entryRe =
    /{\s*(?:\/\/[^\n]*\n\s*)*matcher:\s*'([^']+)',\s*method:\s*(\[[^\]]*\]|'[^']*'),\s*middlewares:\s*\[([^\]]*)\],?\s*}/g;
  ...
    if (middlewaresRaw.includes(bindingName)) {
      entries.push({ matcher, methods: parseMethodField(methodRaw) });
```

The store side uses **many** limiters, bound as consts _and_ inline:
`const storeReadRateLimit = rateLimit('store-read');` (line 79),
`taskActionRateLimit`, `authRateLimit`, `authIdentifierRateLimit`,
`deliveryWriteRateLimit`, … and inline `rateLimit('profile-read')`,
`rateLimit('referral-bind')`. So the store probe must treat an entry as
limited when its `middlewares` array contains **any** identifier that is
either a `const X = rateLimit('…')` binding in the file or an inline
`rateLimit('…')` call. Build the binding set with
`/const\s+(\w+)\s*=\s*rateLimit\('[^']+'\)/g` and test
`middlewaresRaw` against `/\brateLimit\('/` or any binding name.

The blanket entry every store route matches — it carries **no** limiter and
must not count as coverage:

```ts
// middlewares.ts ~1268-1272
    {
      matcher: '/store/*',
      middlewares: [noStoreForAuthenticatedStore, blockDisabledCustomerSession],
    },
```

(Note it has no `method:` field, so `entryRe` above does not match it —
good; keep that property, and add an assertion that the probe never
treats a method-less entry as a limiter.)

The hook entry:

```ts
// middlewares.ts:311-315
      matcher: '/hooks/tgpay/*',
      method: 'POST',
      middlewares: [gatewayHookRateLimit, tgpayCallbackAllowlist],
```

The registry:

```ts
// modules/packs/gateway.ts:75
  hooks: { deposit: string; withdrawal: string; payoutVerify?: string };
// modules/packs/gateway.ts:98-101 (tgpay)
    hooks: {
      deposit: '/hooks/tgpay/deposit',
      withdrawal: '/hooks/tgpay/withdrawal',
    },
// modules/packs/gateway.ts:130-133 (fake — NODE_ENV=test only)
    hooks: {
      deposit: '/hooks/fake/deposit',
      withdrawal: '/hooks/fake/withdrawal',
    },
```

`GATEWAY_IDS` (line ~148) excludes the fake; iterate `GATEWAY_IDS`, not
`Object.keys(GATEWAYS)`, so the fake's hooks (which have no route files and
no middleware) are not asserted.

Store mutation routes at `1bc30e6b` (every `route.ts` under `src/api/store`
exporting POST/PUT/PATCH/DELETE), with the matcher the advisor found for
each — the executor's probe must reproduce this table from the code, not
copy it:

| Route                                                           | Method       | Matcher in middlewares.ts                              |
| --------------------------------------------------------------- | ------------ | ------------------------------------------------------ |
| `/store/credits/deposit`, `/topup`, `/withdraw`                 | POST         | own entries (`credit-topup` / withdraw limiters)       |
| `/store/credits/withdraw/accounts`                              | POST, DELETE | own entries                                            |
| `/store/customers/me/delete`                                    | POST         | own entry                                              |
| `/store/delivery-orders`, `/*/address`, `/*/cancel`             | POST         | `/store/delivery-orders`, `/store/delivery-orders/*`   |
| `/store/notifications/*/read`, `/read-all`                      | POST         | own entries                                            |
| `/store/packs/*/open`, `/open-batch`                            | POST         | own entries                                            |
| `/store/phone-verification/{start,check,change,password-reset}` | POST         | own entries                                            |
| `/store/profile/{avatar,frame}`                                 | POST         | own entries                                            |
| `/store/pulls/*/reveal`, `/close-instant`                       | POST         | own entries                                            |
| `/store/referral/bind`                                          | POST         | own entry                                              |
| `/store/rewards/claim/*`, `/withdraw`                           | POST         | `/store/rewards/*` (SUSPENDED surface — still limited) |
| `/store/tasks/*/claim`, `/checkin`, `/claims/*/spin`            | POST         | own entries                                            |
| `/store/vault/*/buyback`, `/buyback-batch`, `/*/showcase`       | POST         | own entries                                            |

Expected result: the **mutation** EXEMPT list is empty at `1bc30e6b`. If
the probe finds one, that is a finding, not an EXEMPT entry — report it.

Public store **GET** routes with no limiter matcher at `1bc30e6b` (from the
round-15 audit; all pre-delta except `gaps`, all served from a per-process
cache): `/store/pulls/gaps` (plan 134 adds one), `/store/pulls/recent`,
`/store/leaderboard`, `/store/packs`, `/store/packs/*`, `/store/cards/*`,
`/store/challenge`, `/store/pricing/fx`, `/store/avatar-frames`. These are
the candidates for the GET EXEMPT list, each with the reason "cached
per-process for N s; a miss costs one indexed read" — **verify the cache
claim by reading each route** before writing its reason; a route without a
cache goes on the report, not the list.

### Conventions

- Unit specs: jest, `*.unit.spec.ts`, no framework boot; text scans over
  source are an accepted pattern here (the admin probe, the parity tests in
  `modules/packs/__tests__/*parity*`).
- EXEMPT lists are exact-set asserted (`expect(keys).toEqual([...])`) so
  they cannot grow silently — copy that assertion.
- Every exemption carries a `reason` string a reviewer can disagree with.

## Commands you will need

| Purpose                                                          | Command                                                                                           | Expected on success |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck                                                        | `cd backend && corepack yarn check-types`                                                         | exit 0              |
| Lint                                                             | `cd backend && corepack yarn lint`                                                                | exit 0              |
| The two probes                                                   | `cd backend/packages/api && corepack yarn test:unit rate-limit-coverage tgpay-callback-allowlist` | all pass            |
| Whole unit tier (probes are cheap; make sure nothing else broke) | `cd backend/packages/api && corepack yarn test:unit`                                              | 169+ suites pass    |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/api/__tests__/rate-limit-coverage-helpers.ts` (create — the shared scanner)
- `backend/packages/api/src/api/__tests__/admin-rate-limit-coverage.unit.spec.ts` — import from the helper instead of defining the functions inline; **no assertion changes**
- `backend/packages/api/src/api/__tests__/store-rate-limit-coverage.unit.spec.ts` (create)
- `backend/packages/api/src/api/utils/__tests__/tgpay-callback-allowlist.unit.spec.ts` — one new `describe`
- `backend/packages/api/src/api/middlewares.ts` — **only** if plan 134 has not landed and you choose to add the `/store/pulls/gaps` matcher here instead of exempting it (say which in the report)

**Out of scope** (do NOT touch, even though they look related):

- Any limiter **budget** in `rate-limit.ts` — the probe checks presence, not sizing.
- The admin EXEMPT list and its reasons.
- `payer-ip.ts` and the allowlist's behaviour (unplanned SECURITY-03 is about its _log reason_, not its wiring).
- Adding limiters to the cached public GETs — decide EXEMPT vs report; do not add matchers for them in this plan (a `store-read` budget on `/store/packs` would 429 the catalog on a 4K feed page; that needs its own sizing).

## Git workflow

- Branch: `advisor/136-store-rate-limit-coverage`
- Conventional commits, e.g. `test(api): store-side rate-limit coverage probe and hook allowlist wiring assertion`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the scanner

Move `collectRouteFiles`, `routeFileToUrl`, `mutationMethodsOf`,
`matcherToRegExp`, `parseMethodField` and a generalised entry extractor into
`api/__tests__/rate-limit-coverage-helpers.ts`. The generalised extractor:

```ts
export interface LimiterEntry {
  matcher: string;
  methods: string[];
  middlewares: string;
}
/** Every `{ matcher, method, middlewares }` entry in middlewares.ts (method-less entries are NOT returned — they carry no limiter by construction). */
export function extractLimiterEntries(src: string): LimiterEntry[];
/** Names bound as `const X = rateLimit('…')` in the file. */
export function limiterBindings(src: string): Set<string>;
/** True when an entry's middlewares text names a bound limiter or calls rateLimit('…') inline. */
export function isLimited(entry: LimiterEntry, bindings: Set<string>): boolean;
```

The admin spec keeps its `adminActionRateLimit`-specific filter by composing
these (`entries.filter(e => e.middlewares.includes(bindingName))`). Its
assertions must be byte-identical after the move.

**Verify**: `cd backend/packages/api && corepack yarn test:unit admin-rate-limit-coverage` → passes with the same test names and count as before (record the count first: run it once untouched).

### Step 2: The store probe

`store-rate-limit-coverage.unit.spec.ts`, modelled line-for-line on the admin
spec's `describe`:

- `it('extraction is not vacuous')` — `limiterBindings(src).has('storeReadRateLimit')`, entries > 30, an entry with matcher `/store/packs/*/open` exists, no returned entry starts with `/admin`.
- `it('method-less entries are never counted as coverage')` — the `/store/*` blanket entry is absent from `extractLimiterEntries`.
- `it('the MUTATION_EXEMPT list is exactly … — no silent growth')` — expected `[]` at `1bc30e6b`.
- `it('every store route.ts mutation export is rate-limited or explicitly exempt')` — same loop as the admin spec over `path.join(API_ROOT, 'store')`, with `isLimited` as the coverage test and the double-listing check (covered AND exempt → failure).
- `it('every public store GET is rate-limited or on GET_EXEMPT with a reason')` — extend `mutationMethodsOf` with a sibling `getMethodsOf` (match `export (async )?function GET` / `export const GET`); assert each GET route is limited or exempt; `GET_EXEMPT` exact-set asserted. Populate it from your own scan (expected members listed under Current state, minus `gaps` if plan 134 has landed), each with a reason that names the route's cache constant (e.g. `CACHE_TTL_MS` in `pulls/recent/route.ts`) — read each route to write it.

**Verify**: `cd backend/packages/api && corepack yarn test:unit store-rate-limit-coverage` → all pass. Then the mutation check: comment out the `/store/referral/bind` entry's `middlewares` limiter in a scratch copy of `middlewares.ts`… no — do not edit the real file for this; instead temporarily change the probe's `isLimited` to always return `false` and confirm the mutation test fails naming ≥ 25 routes; restore.

### Step 3: Hook allowlist wiring assertion

In `tgpay-callback-allowlist.unit.spec.ts`, add:

```ts
describe('wiring — every gateway hook path carries the limiter AND the allowlist', () => {
  it('middlewares.ts has an entry matching each GATEWAYS[id].hooks path with both middlewares', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../middlewares.ts'),
      'utf8',
    );
    const entries = extractLimiterEntries(src).map((e) => ({
      ...e,
      re: matcherToRegExp(e.matcher),
    }));
    for (const id of GATEWAY_IDS) {
      for (const hookPath of Object.values(GATEWAYS[id].hooks)) {
        const hit = entries.find(
          (e) => e.methods.includes('POST') && e.re.test(hookPath),
        );
        expect(hit, `${hookPath} has no POST middleware entry`).toBeDefined();
        expect(hit!.middlewares).toMatch(/\bgatewayHookRateLimit\b/);
        expect(hit!.middlewares).toMatch(/\btgpayCallbackAllowlist\b/);
      }
    }
  });
});
```

Import `GATEWAYS`, `GATEWAY_IDS` from `../../../modules/packs/gateway` and
the helpers from `../../__tests__/rate-limit-coverage-helpers`. If importing
`gateway.ts` into this spec drags in module-level env reads that throw under
jest, guard with the same `process.env` save/restore the file already has
(lines 3-12) and set `TGPAY_API_BASE` to a sandbox value for the test.

Also assert the **negative**: `expect(entries.some(e => e.re.test('/hooks/tgpay') && e.methods.includes('POST'))).toBe(false)` — the matcher note at `middlewares.ts:305-310` records that the bare prefix must not match.

**Verify**: `cd backend/packages/api && corepack yarn test:unit tgpay-callback-allowlist` → passes; mutation: temporarily change the spec's expected identifier to `tgpayCallbackAllowlistX` → fails; restore.

### Step 4: Full verification

Run the Commands table.

## Test plan

Covered by Steps 1–3 (this plan _is_ tests). Additional mutation proofs to
run and mention in the report: (1) remove `storeReadRateLimit` from the
`/store/payments/config` entry in a **scratch copy** of `middlewares.ts` fed
to the helper (the helper takes `src` as a string, so the test can be
exercised against a modified string without touching the file) → the store
probe's mutation-route loop should not care (it is a GET) but the GET loop
must flag it; (2) drop the `tgpayCallbackAllowlist` identifier from the hook
entry in the same scratch string → Step 3 fails.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd backend/packages/api && corepack yarn test:unit rate-limit-coverage tgpay-callback-allowlist` exits 0; the admin probe's test count is unchanged
- [ ] `ls backend/packages/api/src/api/__tests__/` shows `rate-limit-coverage-helpers.ts`, `admin-rate-limit-coverage.unit.spec.ts`, `store-rate-limit-coverage.unit.spec.ts`
- [ ] `grep -c "MUTATION_EXEMPT" backend/packages/api/src/api/__tests__/store-rate-limit-coverage.unit.spec.ts` ≥ 2 and its exact-set assertion is `[]`, OR the report names the route(s) that forced a non-empty list as findings
- [ ] `grep -c "GATEWAY_IDS" backend/packages/api/src/api/utils/__tests__/tgpay-callback-allowlist.unit.spec.ts` → `1`
- [ ] `cd backend && corepack yarn check-types && corepack yarn lint` exit 0
- [ ] `git status --porcelain` lists only in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- `middlewares.ts` no longer uses the `{ matcher, method, middlewares }`
  literal shape the regex relies on (e.g. entries built by a helper
  function) — the text-scan approach is dead and the probe needs the
  runtime `defineMiddlewares` output instead.
- The admin probe's test count changes after Step 1 (you altered behaviour
  while extracting).
- A store **mutation** route is found with no limiter — do not add it to
  EXEMPT; report it with the route path and stop (it is a security finding
  for the reviewer).
- `GATEWAYS[*].hooks` gains a `payoutVerify` path with no route file under
  `src/api/hooks/` — the assertion would fail for a path that is not
  reachable; report rather than special-case.

## Maintenance notes

- A new store route that must stay unlimited goes on the relevant EXEMPT
  list **with a reason** in the same PR; the exact-set assertion is what
  makes the reviewer see it.
- A second real gateway adds its hook paths to `GATEWAYS[id].hooks` and
  needs its own allowlist middleware; Step 3's assertion currently names
  `tgpayCallbackAllowlist` — generalise to "an allowlist middleware for that
  gateway" then, not now.
- Plan 134 and this plan touch `middlewares.ts` in different regions
  (`/store` block vs nothing) — no merge conflict expected; if 136 lands
  first with `gaps` on `GET_EXEMPT`, 134's PR must remove that entry.
