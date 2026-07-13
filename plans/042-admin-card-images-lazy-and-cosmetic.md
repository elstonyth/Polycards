# Plan 042: Lazy-load admin card images + fix the stop-hook mojibake banner

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- backend/apps/admin/src/routes/cards/page.tsx backend/apps/admin/src/routes/packs backend/apps/admin/src/routes/daily-rewards/page.tsx .claude/hooks/stop-verify.js`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / dx
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

Two small, safe wins bundled:

1. **Admin card images render eagerly with no windowing.** The admin card
   catalog (`cards/page.tsx`) loads the entire catalog (`useCards()` →
   backend `take: 1000`) and renders one `<img>` per card with no
   `loading="lazy"`; two card-picker modals do the same full-catalog eager
   render. At the current ~26-card seed this is negligible, but it scales
   toward 1000 DOM rows + 1000 simultaneous image requests as the catalog
   grows. Across the admin SPA only 1 of ~20 `<img>` sites uses lazy loading.
   Adding `loading="lazy"` is a safe win at any magnitude (full pagination is
   deferred until the catalog actually grows).
2. **The Stop-hook failure banner prints mojibake.** `.claude/hooks/stop-verify.js`
   has broken UTF-8 in its comments and its runtime `console.error` banner
   (garbled bullets), so the blocking message a developer sees on a failed
   type-check is ugly. Cosmetic; the gate itself works.

## Current state

**Admin card list** — `backend/apps/admin/src/routes/cards/page.tsx` renders
(~line 382):

```tsx
{visible.map((c) => (
  <Table.Row key={c.handle}>
    <Table.Cell>
      <div className="flex items-center gap-3">
        <img
          src={resolveImageUrl(c.slab_image || c.image)}
          alt=""
          className="h-10 w-8 shrink-0 rounded object-contain"
        />
```

No `loading` attribute. `useCards()` pulls the whole catalog (backend
`admin/cards/route.ts` `listCards({}, { take: 1000 })`).

Two more full-catalog eager-image renders (card pickers) at:

- `backend/apps/admin/src/routes/packs/[slug]/page.tsx` (~line 592-602,
  `allCards.map` inside a FocusModal `<img>`).
- `backend/apps/admin/src/routes/daily-rewards/page.tsx` (~line 978-989,
  card picker `<img>`).

Confirm the exact `<img>` sites before editing:
`grep -rn "<img" backend/apps/admin/src/routes/cards/page.tsx backend/apps/admin/src/routes/packs/\[slug\]/page.tsx backend/apps/admin/src/routes/daily-rewards/page.tsx`.

**Stop hook** — `.claude/hooks/stop-verify.js`: broken UTF-8 in the header
comment (~line 2) and the `console.error` bullets (~lines 76, 81, 90-92). The
hook type-checks storefront + backend + admin and runs storefront vitest; it
is functionally correct.

## Commands you will need

| Purpose         | Command                                                                                               | Expected          |
| --------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| Admin install   | `corepack yarn install` (in `backend/`)                                                               | exit 0            |
| Admin build     | `corepack yarn workspace @acme/admin build` (or `turbo run build --filter=@acme/admin` in `backend/`) | exit 0            |
| Admin typecheck | covered by the admin `build` (`tsc -b && vite build`)                                                 | exit 0            |
| Hook sanity     | `node --check .claude/hooks/stop-verify.js`                                                           | exit 0 (valid JS) |

## Scope

**In scope**:

- `backend/apps/admin/src/routes/cards/page.tsx` — add `loading="lazy"` to the
  list `<img>`.
- `backend/apps/admin/src/routes/packs/[slug]/page.tsx` — add `loading="lazy"`
  to the picker `<img>`.
- `backend/apps/admin/src/routes/daily-rewards/page.tsx` — add `loading="lazy"`
  to the picker `<img>`.
- `.claude/hooks/stop-verify.js` — re-encode the mojibake comments/banner as
  clean UTF-8. **Behavior must not change** — only the byte-content of comment
  and string-literal characters.

**Out of scope**:

- Pagination/windowing of the admin card list — deferred until the catalog
  grows (note in Maintenance). Do NOT add a `Pager` here.
- The backend `take: 1000` — leave it.
- Any hook _logic_ in `stop-verify.js` — only fix the garbled characters.
- Other admin `<img>` sites not in the three files above.

## Git workflow

- Branch: `advisor/042-admin-card-images-lazy-and-cosmetic`
- Commits: `perf(admin): lazy-load catalog card images`,
  `chore(hooks): fix mojibake in the stop-verify banner`.
- Do not push or open a PR.

## Steps

### Step 1: Add lazy loading to the three `<img>` sites

Add `loading="lazy"` (and, harmlessly, `decoding="async"`) to the card `<img>`
in each of the three files. Change nothing else about the elements.

**Verify**: `grep -rn 'loading="lazy"'
backend/apps/admin/src/routes/cards/page.tsx
backend/apps/admin/src/routes/packs/\[slug\]/page.tsx
backend/apps/admin/src/routes/daily-rewards/page.tsx` → 3 matches (one per
file). `corepack yarn workspace @acme/admin build` → exit 0.

### Step 2: Fix the stop-hook banner encoding

Open `.claude/hooks/stop-verify.js` and replace the garbled sequences (e.g.
`â€"`, `â€¢`, `Â·`) with the intended clean characters (an em dash `—` and a
bullet `•`, or plain ASCII `-`/`*` if you prefer — the point is legible
output). Do not alter any code, condition, path, or command.

**Verify**: `node --check .claude/hooks/stop-verify.js` → exit 0.
`git diff .claude/hooks/stop-verify.js` → only comment/string characters
changed, no logic lines.

## Test plan

No new tests — Step 1 is a presentational attribute add (covered by the admin
build compiling) and Step 2 is a comment/string re-encode (covered by
`node --check` and a diff review). The admin route is Playwright-covered
end-to-end; a lazy attribute doesn't change assertions.

## Done criteria

- [ ] `loading="lazy"` present in all three `<img>` sites (grep → 3)
- [ ] `corepack yarn workspace @acme/admin build` exits 0
- [ ] `node --check .claude/hooks/stop-verify.js` exits 0
- [ ] `git diff .claude/hooks/stop-verify.js` touches no logic lines
- [ ] `git status` shows no files outside scope

## STOP conditions

- A card `<img>` site isn't where the excerpt says (drift) — grep for the
  actual site and report if it's structurally different.
- The stop-hook file, once re-encoded, fails `node --check` (you altered more
  than characters) — revert and report.

## Maintenance notes

- **When the catalog grows past a few hundred cards**, give `cards/page.tsx`
  the same client-side `Pager`/`PAGE_SIZE` slice its sibling routes
  (`pulls/page.tsx`, `pixel-pokemon/page.tsx`) already use — the data is
  already all in memory, so it's a render-slice, not a fetch change. Lazy
  loading is the interim; pagination is the real fix at scale.
- The stop hook is machine-local tooling; a reviewer only needs to confirm the
  gate still blocks on type errors (unchanged logic).
