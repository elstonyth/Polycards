# The admin dashboard is raw `@medusajs/ui`, not the Mercur shared layer

`backend/apps/admin` is not the upstream Mercur starter. It mounts a prebuilt
dashboard bundle — `src/main.tsx` is 11 lines rendering `App` from
`@mercurjs/admin`, with our own routes injected by `mercurDashboardPlugin` in
`vite.config.ts` — and every screen we wrote on top of it is composed from
`@medusajs/ui` primitives plus seven local components (`Pager`,
`LoadingSkeleton`, `StickySaveBar`, `PullsTable`, `RowActions`,
`GachaPipelineHint`, `GraderGradeSelect`). We chose to keep it that way. The
Mercur dashboard skills in `backend/.claude/skills/` describe the starter, and
the starter's conventions are not this fork's; where they disagree, this file
wins. This covers `apps/admin` only: `apps/vendor` is a bare mount of
`@mercurjs/vendor` — one `main.tsx`, no routes of our own — so it has no house
style yet, and adding custom vendor routes reopens every question below.

The evidence, measured against `backend/apps/admin/src` (52 `.ts`/`.tsx` files,
16 route `page.tsx`, 12 of which render a table; 14 files do counting the two
non-page components):

- **`@mercurjs/dashboard-shared` has zero imports.** It resolves only because
  it is a dependency of `@mercurjs/admin`; `apps/admin/package.json` declares
  one dashboard dependency, `@mercurjs/admin@2.1.6`, plus three `@acme/*`
  workspace packages. The house stack is `@medusajs/ui` (identifier
  occurrences across those files: `Table` 786, `Button` 211, `FocusModal` 100).
- **No form uses `react-hook-form` + `zod` + `RouteFocusModal`** — zero imports
  of all three. The idiom is `useState` and a derived `canSave` (10 files) with
  `@medusajs/ui`'s `FocusModal` (8 files) / `Prompt` / `toast`.
- **`_DataTable` is marked `@deprecated` in `dashboard-shared`'s own
  `dist/index.d.ts`** ("Use the DataTable component from
  `/components/data-table` instead").
- **i18n is split**: 9 of the 16 route pages call `useTranslation`, 7 hardcode
  English, against a single locale file (`src/i18n/en.json`).

## Consequences

- Build new admin UI from `@medusajs/ui` and the local components. Do not
  import from `@mercurjs/dashboard-shared` — adopting `_DataTable` would make
  one page the sole user of a deprecated table system in a dashboard where 14
  files (12 of them route pages) already render `@medusajs/ui` tables, and
  would depend on a package we do not declare.
- Keep the `useState` + `canSave` + `FocusModal` form idiom. `react-hook-form`
  and `zod` are already resolvable, so schema validation could be adopted
  without a new install — but only *transitively*, via `@mercurjs/admin`, so
  anything that starts importing them must add them to
  `apps/admin/package.json` first or a bundle bump can delete them. The
  `RouteFocusModal` container half is a real migration and is not worth it.
- **i18n: match the file you are editing.** Do not migrate either direction.
  This is an internal single-operator tool, English-only, with one locale file;
  `routes/packs/page.tsx:43-44` already records that rationale and defers
  localization. All 13 `RouteConfig.label`s are hardcoded English literals;
  they cannot use `t()` (no hook in scope at module scope), but they are not
  un-localizable — `RouteConfig` carries an optional `translationNs`, which is
  the one documented switch and should be flipped once for all 13 deliberately,
  never incidentally while editing a page. Within one screen, though, one value
  gets one name: the ledger list rendered the raw code `TP` in its Type column
  and the translated "Top-up" on the filter button for the same value, and that
  is a bug regardless of which side you settle on.
- **Check any new admin route against the core Medusa route table before
  placing it.** `mergeRoutes` (in `@mercurjs/admin/dist/index.js`) matches
  custom routes to core routes *by path*, comparing with leading slashes
  stripped, and spreads the custom route over the core one. `createLeafRoute`
  returns `{ path, ErrorBoundary, lazy }`, so the custom `lazy` overwrites
  core's — while `children` are *preserved from core*. Core defines
  `{ path: "/inventory", children: [{ path: "", lazy: inventory-list,
  children: [create, stock] }, { path: ":id", ... }] }`, so a custom
  `src/routes/inventory/page.tsx` would silently render in place of Medusa's
  Inventory Items page, and the surviving `create` / `stock` / `:id` children
  would then have no `<Outlet/>` to render into. Nest under a segment core does
  not own (e.g. `/inventory/list`). This is live, not historical: the Epic 5
  inventory plan currently names `routes/inventory/page.tsx`.
- The skills stay useful for routing shape and page structure. Treat them as
  starter documentation, not as a description of this codebase, and prefer a
  neighbouring shipped page as the precedent for anything they contradict.
