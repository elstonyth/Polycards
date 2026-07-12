# Plan 012: Fix blank pack titles in the admin pull ledger (wrong join key)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/packages/api/src/api/admin/pulls/route.ts backend/packages/api/src/modules/packs/models/pull.ts`
> If either file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

The admin pull ledger (`GET /admin/pulls`) joins each pull to its pack to show a
`pack_title` column. The join filters `listPacks({ id: packIds })`, but
`Pull.pack_id` holds the pack **slug**, not the pack id — so the filter matches
no rows and **every** ledger row's `pack_title` is `null`. This is a delta
regression: the baseline route didn't join packs at all; the join was added and
shipped broken. The two sibling routes that do the same join get it right by
filtering on `slug`. The fix is to match them: filter by `slug` and key the
lookup map by `slug`.

## Current state

- `backend/packages/api/src/api/admin/pulls/route.ts:116-120` — the broken join:

  ```ts
  const packIds = [...new Set(ledger.map((p) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ id: packIds }, { take: packIds.length })
    : [];
  const packTitleById = new Map(packRows.map((pk: any) => [pk.id, pk.title]));
  ```

- `backend/packages/api/src/modules/packs/models/pull.ts:15` — proves the key:

  ```ts
  pack_id: model.text(), // = Pack.slug
  ```

- Correct sibling (the exemplar to match) —
  `backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts:50-54`:

  ```ts
  const packIds = [...new Set(rows.map((p: any) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
    : [];
  const packBySlug = new Map(packRows.map((p: any) => [p.slug, p]));
  ```

  (`api/store/pulls/recent/route.ts:88` does the same `{ slug: packIds }`.)

## Commands you will need

| Purpose            | Command                                                      | Expected |
| ------------------ | ------------------------------------------------------------ | -------- |
| Backend build      | from `backend/packages/api`: `npm run build`                 | exit 0   |
| Backend HTTP tests | from `backend/packages/api`: `npm run test:integration:http` | all pass |

## Scope

**In scope:**

- `backend/packages/api/src/api/admin/pulls/route.ts` (fix the filter + map key)
- A new/extended integration spec asserting `pack_title` is populated (see Test plan)
- `plans/README.md` (this plan's status row only)

**Out of scope:**

- The two sibling routes — already correct; do not touch.
- The `Pull` model or the `record-pull` step — the stored key is by design (`= Pack.slug`).

## Git workflow

- Branch: `advisor/012-admin-pull-ledger-pack-title`
- Conventional commits, e.g. `fix(admin): admin pull ledger joins packs by slug, not id`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the filter and the map key

In `admin/pulls/route.ts:116-120`, change the filter to `{ slug: packIds }` and
key the map by `pk.slug`. Rename `packTitleById` → `packTitleBySlug` for
accuracy, and update its lookup site (grep the file for `packTitleById` to find
where the map is read into each row's `pack_title`).

```ts
const packRows = packIds.length
  ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
  : [];
const packTitleBySlug = new Map(packRows.map((pk: any) => [pk.slug, pk.title]));
// ...and at the read site: pack_title: packTitleBySlug.get(p.pack_id) ?? null
```

**Verify**: backend build → exit 0.

### Step 2: Add/extend a test asserting non-null pack_title

Add an integration assertion (in a `pulls`-related HTTP spec, or a new
`admin-pulls.spec.ts` if none covers this route) that after a pack open, `GET
/admin/pulls` returns a row whose `pack_title` equals the opened pack's title
(not null). Model the setup after an existing admin HTTP spec that opens a pack
and reads back admin data.

**Verify**: from `backend/packages/api`, run the spec → passes; `pack_title` is non-null.

## Test plan

- New/extended HTTP spec: open a pack as a customer, then `GET /admin/pulls` and
  assert the ledger row's `pack_title` matches the pack title.
- Verification: the spec passes; backend build exit 0.

## Done criteria

- [ ] `admin/pulls/route.ts` filters `listPacks({ slug: … })` and keys the map by slug.
- [ ] Every read site of the old `packTitleById` is updated.
- [ ] A test asserts `pack_title` is populated (non-null) for a real pull.
- [ ] Backend build exits 0; the spec passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- `Pull.pack_id` is NOT `= Pack.slug` in the live model (drift) — stop; the whole
  premise is the join key.
- `listPacks` does not accept a `slug` filter (drift) — stop; the sibling routes
  prove it should.

## Maintenance notes

- Any new join from a pull to its pack must use `slug` (that's what `pack_id`
  stores). If the model ever switches `pack_id` to a real id, all three routes
  change together.
- A reviewer should confirm the map-key rename is applied at both the build and
  read sites (no lingering `packTitleById`).
