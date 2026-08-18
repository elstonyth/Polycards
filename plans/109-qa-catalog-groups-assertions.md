# Plan 109: Give the catalog-groups QA gate assertions that can actually fail

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 16cc85d3..HEAD -- scripts/qa-catalog-groups.mjs src/app/slots/CatalogClient.tsx src/lib/packs-data.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of 107, but both touch the nightly's gate
  list — land 107 first if you are batching, so a green nightly is observable)
- **Category**: tests
- **Planned at**: commit `16cc85d3`, 2026-08-18

## Why this matters

`scripts/qa-catalog-groups.mjs` is wired into the nightly E2E workflow as an
`always()` gate. It screenshots `/slots` at two viewports, reads some text into
variables, `console.log`s them, and exits 0 — **unconditionally**. There is no
`throw`, no `process.exit(1)`, no comparison of any kind. The only thing that
can turn it red is Playwright itself crashing or the storefront not answering.

This repo has already been burned by exactly this: an a11y gate that reported
green while parsing nothing at all, because "0 violations" was true and "0
passes" was never checked. A gate that cannot fail is worse than a missing gate,
because the workflow's gate summary lists it as passing and a reader concludes
the catalog grouping is covered.

The grouping it is supposed to cover is not cosmetic. The section headings are
**truth claims about pool composition** — "Graded (Guaranteed PSA 10)" and
"Raw Cards (Ungraded)" assert things about what a customer is buying. A silent
regression that drops a pack out of every section, or renders an empty section,
or puts a mixed pool under an "Ungraded" heading, is a trust bug that this gate
currently cannot see.

After this plan: the gate asserts the structural invariants the grouping code
guarantees, and fails when one breaks.

## Current state

### The whole script, as it stands (34 lines)

`scripts/qa-catalog-groups.mjs`:

```js
// QA: /slots composition catalog (Graded / Raw / More Packs) — headings,
// membership counts, screenshots. Sections are read dynamically from the DOM,
// so this script needs no update when a section is added/removed/empty.
// Run against a self-built server: node scripts/qa-catalog-groups.mjs [base]
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const browser = await chromium.launch();

const shoot = async (width, height, out) => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // Reveal animations settle
  const headings = await page.locator('section h2').allInnerTexts();
  const counts = await page
    .locator('section span.ml-auto')
    .allInnerTexts()
    .catch(() => []);
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return { headings, counts };
};

const desktop = await shoot(
  1440,
  900,
  'docs/research/qa-catalog-groups-desktop.png',
);
const mobile = await shoot(
  393,
  852,
  'docs/research/qa-catalog-groups-mobile.png',
);
console.log('desktop sections:', JSON.stringify(desktop));
console.log('mobile sections:', JSON.stringify(mobile));
await browser.close();
```

No assertion anywhere. It already extracts everything the assertions need.

### How it is wired

```yaml
# .github/workflows/e2e.yml
- name: Run catalog-groups QA gate
  id: qacg
  if: always()
  run: npm run qa:catalog-groups
```

and `package.json`: `"qa:catalog-groups": "node scripts/qa-catalog-groups.mjs"`.
The nightly's gate-summary step reports its outcome, so a real failure here is
already legible once the script can produce one.

### What the page actually guarantees

`src/lib/packs-data.ts` — the grouping is a total, first-match-wins partition:

```ts
export type CatalogGroup = 'graded' | 'raw' | 'more';
export const catalogGroupOf = (p: Pack): CatalogGroup => {
  if (inGuaranteedGroup(p)) return 'graded';
  if (p.group === 'RAW') return 'raw';
  return 'more';
};

export const CATALOG_GROUP_ORDER: readonly CatalogGroup[] = [
  'graded',
  'raw',
  'more',
];
export const CATALOG_GROUP_HEADING: Record<CatalogGroup, string> = {
  graded: 'Graded',
  raw: 'Raw Cards',
  more: 'More Packs',
};
```

`src/app/slots/CatalogClient.tsx:355-382` — only non-empty sections render, each
with an `<h2>` (heading + optional parenthetical note) and a right-aligned count:

```tsx
      {/* Composition sections — only the non-empty ones render. */}
      {CATALOG_GROUP_ORDER.filter((id) => byGroup[id].length > 0).map((id) => {
        const g = GROUP_CHROME[id];
        return (
          <section key={id} className="mb-8">
            <div className="mb-4 flex items-center gap-2.5">
              <g.Icon className="h-6 w-6 shrink-0 text-white/80" aria-hidden />
              <h2 className="font-heading text-lg font-bold tracking-tight text-white sm:text-xl">
                {CATALOG_GROUP_HEADING[id]}
                {g.note && (<> <span className="...">({g.note})</span></>)}
              </h2>
              <span className="ml-auto text-[13px] text-white/60">
                {byGroup[id].length}{' '}
                {byGroup[id].length === 1 ? 'pack' : 'packs'}
              </span>
            </div>
```

with the notes:

```tsx
// src/app/slots/CatalogClient.tsx:251-252
  graded: { note: 'Guaranteed PSA 10', Icon: ShieldCheck },
  raw:    { note: 'Ungraded',          Icon: RectangleVertical },
```

`more` has no note — deliberately, because no claim is true for every pack in it.

Every catalog pack tile is an `<a>` whose `href` carries `count=` (this is how
`scripts/qa-free-pack.mjs` identifies catalog tiles — see its
`page.locator('a[href*="count="]')`). That is the handle for counting tiles.

### **The fixture reality you must design assertions around**

The CI database is seeded by `seed:e2e`, which installs a mirror of the
production catalog: **five packs, all graded pools**. On that catalog only the
`Graded` section renders — possibly plus `More Packs`. A local dev database may
additionally carry a hand-made raw fixture pack.

Therefore: **do not assert that all three sections exist, and do not assert any
absolute pack count.** Both would false-fail on CI, on prod, and on a dev box,
in different directions. Assert the invariants the _code_ guarantees, which hold
on any catalog. Those are listed in Step 2.

### Conventions

- Plain ESM `.mjs` under `scripts/`, run with bare `node`, Playwright driven.
- `ok()` / `fail()` helpers, `process.exitCode = 1` (never `process.exit` before
  the end — every assertion should get to report). Copy the exact helpers from
  `scripts/qa-free-pack.mjs:43-48`:

```js
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);
```

- Screenshots to `docs/research/` (gitignored) — keep them, they are the triage
  artifact when an assertion fails.
- Comments explain **why** an assertion exists and what regression it catches.

## Commands you will need

| Purpose      | Command                                                    | Expected on success                    |
| ------------ | ---------------------------------------------------------- | -------------------------------------- |
| Syntax check | `node --check scripts/qa-catalog-groups.mjs`               | exit 0, no output                      |
| Lint         | `npm run lint`                                             | exit 0                                 |
| Format check | `npm run format:check`                                     | exit 0 (separate from `npm run check`) |
| Typecheck    | `npm run typecheck`                                        | exit 0                                 |
| Unit tests   | `npm test`                                                 | all pass                               |
| Run the gate | `node scripts/qa-catalog-groups.mjs http://localhost:4000` | exit 0, every line `✓`                 |

Running the gate needs a **production** storefront build, never `next dev`
(`next dev` serves images slowly enough on this machine to look broken):

```
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000
```

with the backend up on `:9000` (`corepack yarn dev` from
`backend/packages/api`).

## Scope

**In scope**:

- `scripts/qa-catalog-groups.mjs`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/app/slots/CatalogClient.tsx` and `src/lib/packs-data.ts` — the grouping
  is correct and was reviewed when it shipped; this plan makes the gate able to
  see it, not change it. If an assertion you write fails against the real page,
  that is a finding to report, **not** a licence to edit the page.
- `.github/workflows/e2e.yml` — the step is wired correctly already.
- `src/lib/__tests__/catalog-group.test.ts` — the unit coverage of
  `catalogGroupOf` / `groupPacks` already exists and is good; this gate covers
  the rendered page, which unit tests cannot.
- Any other `scripts/qa-*.mjs`.

## Git workflow

- Branch: `advisor/109-catalog-groups-assertions`
- Conventional commit, e.g.
  `test(qa): make the catalog-groups gate assert instead of only screenshot`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the helpers and make the script's exit code meaningful

Add the `ok` / `fail` helpers (copied verbatim from `scripts/qa-free-pack.mjs`)
and keep the existing screenshot behaviour. Replace the two bare `console.log`
dumps at the end with the assertions from Step 2 — the raw JSON dump stays
useful, so keep it as a single line printed **before** the assertions run, so a
failure report has the data next to it.

Update the header comment: it currently describes a screenshot script. It must
say what the gate asserts and, explicitly, that the assertions are
catalog-shape-independent because the seeded CI catalog is graded-only.

**Verify**: `node --check scripts/qa-catalog-groups.mjs` → exit 0.

### Step 2: Assert the invariants that hold on any catalog

Extract, per viewport: the section headings, the section counts, and the number
of rendered pack tiles. Then assert:

1. **At least one section renders.** Zero sections means the catalog failed to
   load or the grouping collapsed — the most basic thing the current script
   cannot detect. `fail` with the raw headings array in the message.

2. **Every heading is one of the known set.** Parse each `<h2>` text and match
   its leading heading against `['Graded', 'Raw Cards', 'More Packs']`. An
   unknown heading means the copy drifted from `CATALOG_GROUP_HEADING` without
   anyone noticing.

3. **Sections appear in `CATALOG_GROUP_ORDER`.** The rendered order must be a
   subsequence of `['Graded', 'Raw Cards', 'More Packs']`. Order is part of the
   design (guarantee first).

4. **No duplicate headings.** Two `Graded` sections means the partition broke.

5. **The notes are attached to the right headings, and only those.**
   `Graded` must carry `(Guaranteed PSA 10)`, `Raw Cards` must carry
   `(Ungraded)`, and `More Packs` must carry **no** parenthetical. This is the
   truth-claim assertion — it is the one that catches an overclaim, e.g. a note
   migrating onto the catch-all section.

6. **Every section's count is ≥ 1**, and its stated noun agrees with its number
   (`1 pack` vs `N packs`). An empty section cannot render by construction, so a
   zero here means the count and the membership disagree.

7. **The counts sum to the number of rendered pack tiles.** Count tiles with
   `page.locator('a[href*="count="]')`. The partition is total and disjoint, so
   `Σ section counts === tile count` must hold exactly. This is the assertion
   that catches a pack silently dropping out of every section — the failure
   mode with the worst consequence and the least visible symptom.

8. **Desktop and mobile agree.** The same headings, in the same order, with the
   same counts, at both viewports. The two renders differ in layout only;
   a divergence means a breakpoint-gated filter crept in.

Write each assertion with a comment naming the regression it catches. Use `fail`
for every one — do not `throw` on the first, or a single break hides the rest.

**Verify**: `node --check scripts/qa-catalog-groups.mjs` → exit 0, and
`grep -c "fail(" scripts/qa-catalog-groups.mjs` → ≥ 8.

### Step 3: Prove the assertions are load-bearing

This is the step that distinguishes this plan from the problem it fixes. For at
least **three** of the assertions above (must include #5 and #7), demonstrate
that the gate goes red when the invariant is broken. Two ways, either is
acceptable — pick per assertion and say which you used:

- **Preferred, no source edits**: use Playwright to mutate the live DOM before
  asserting — e.g. `page.evaluate` to delete one pack tile (breaks #7), or to
  rewrite a heading's note span (breaks #5) — in a temporary throwaway copy of
  the script. Run it, confirm a `✗` line and a non-zero exit code, then delete
  the throwaway.
- **Fallback — use ONLY if the DOM path genuinely cannot reach the assertion**
  (e.g. the invariant is computed before render and no DOM edit can violate it).
  If you take this path, first state in your report _why_ the DOM mutation could
  not express that break. Then temporarily edit `CatalogClient.tsx` (e.g. move
  the `note` onto `more`), rebuild, run the gate, confirm red, then
  `git checkout -- src/app/slots/CatalogClient.tsx`. **The revert is
  mandatory** — that file is out of scope, a done-criterion checks it is absent
  from `git status`, and leaving it modified fails the plan.

**Verify**: your report contains, for each of the three, the exact `✗` line the
mutated run produced and the exit code. `git status --short` must not list
`src/app/slots/CatalogClient.tsx`.

### Step 4: Run the gate green against a real build

Bring up the backend and a production storefront build (see "Commands you will
need"), then:

**Verify**: `node scripts/qa-catalog-groups.mjs http://localhost:4000` → exit 0,
every printed line begins `✓`, and `echo $?` is `0`.

If you cannot bring the stack up, say so explicitly in your report and mark this
step not-run. Do **not** claim it passed.

### Step 5: Static gates

**Verify** (all must pass):

```
npm run lint
npm run format:check
npm run typecheck
npm test
```

If only `scripts/qa-catalog-groups.mjs` fails the format check, run
`npx prettier --write scripts/qa-catalog-groups.mjs` and re-check. Do not run
the repo-wide `npm run format`.

## Test plan

The script _is_ the test. Its own coverage is the mutation proof in Step 3 —
that is the only evidence that distinguishes a real gate from the vacuous one
being replaced. No new unit test file: `src/lib/__tests__/catalog-group.test.ts`
already covers `catalogGroupOf` / `groupPacks` at the logic level, and this gate
exists precisely to cover what those cannot (the rendered page).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --check scripts/qa-catalog-groups.mjs` exits 0
- [ ] `grep -c "fail(" scripts/qa-catalog-groups.mjs` ≥ 8
- [ ] `grep -c "process.exitCode" scripts/qa-catalog-groups.mjs` ≥ 1
- [ ] `grep -n "Guaranteed PSA 10" scripts/qa-catalog-groups.mjs` → ≥1 match
      (assertion #5 exists)
- [ ] `npm run lint` exits 0
- [ ] `npm run format:check` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0
- [ ] Mutation proof run for ≥3 assertions incl. #5 and #7, with the `✗` lines
      and non-zero exit codes quoted in the report
- [ ] `git status --short` lists only `scripts/qa-catalog-groups.mjs` and
      `plans/README.md`
- [ ] `plans/README.md` status row for 109 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `CatalogClient.tsx` or `packs-data.ts` changed since
  `16cc85d3` and the headings / notes / markup no longer match the excerpts.
- An assertion fails against an unmodified, correctly-seeded catalog. That is a
  **finding about the page**, not a reason to weaken the assertion. Report the
  exact failure and stop — softening an assertion until it passes is how the
  vacuous gate got here.
- Assertion #7 (counts sum to tiles) cannot be made to hold because the catalog
  renders tiles outside the sections (e.g. a promotional tile with a `count=`
  href). Report what the extra tiles are; the fix is a narrower tile selector,
  but do not invent one silently.
- The mutation proof in Step 3 does **not** produce a red run for an assertion.
  That assertion is not load-bearing — say which one and why.

## Maintenance notes

- **What will interact with this**: any change to `CATALOG_GROUP_HEADING`,
  `GROUP_CHROME`'s notes, or `CATALOG_GROUP_ORDER` will fail assertions #2, #3
  or #5 by design. That is the point — update the gate deliberately, in the same
  PR, and re-run the mutation proof for whichever assertion you touched.
- **A reviewer should scrutinize**: that no assertion depends on a specific pack
  count or on all three sections existing (the CI catalog is graded-only), and
  that the mutation proof was actually run.
- **The general rule this instance belongs to**: this repo now has three
  `npm run qa:*` scripts wired as nightly gates. Before adding a fourth, prove
  it can go red. `scripts/qa-csp.mjs` and `scripts/qa-free-pack.mjs` both assert;
  this one did not.
- **Deferred out of this plan**: the script does not check that a pack's
  section actually matches its backend-derived composition — it can only see
  what the page renders. Cross-checking against `GET /store/packs` (which
  carries `group` / `psa10`) would close that, and is a separate change.
