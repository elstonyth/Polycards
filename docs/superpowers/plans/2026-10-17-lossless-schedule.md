# Lossless Mode Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-scheduled "Lossless Mode" windows during which chosen packs' instant (30s reveal) buyback is 100%, overlaid on — never written into — each pack's own `buyback_percent`.

**Architecture:** A new `lossless_schedule` table in the packs module. A pure module (`lossless.ts`) decides whether a pack is lossless at an instant from a preloaded list of windows; every pricing/display site loads the windows once and hands `resolveBuybackRate` a pack whose `buyback_percent` is replaced by 100 when lossless. Admin routes create/list/cancel windows (audited, rate-limited); the admin Packs page gets a "Lossless Mode" tab.

**Tech Stack:** Medusa v2 (packs module, MikroORM migrations), jest (`test:unit`, `test:integration:modules`, `test:integration:http`), admin = Vite + React + @medusajs/ui + react-query + vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-lossless-schedule-design.md`

All paths below are relative to the worktree root `.worktrees/feat-lossless-schedule/`. Backend commands run from `backend/packages/api`, admin from `backend/apps/admin`.

## Global Constraints

- Vault / flat rate stays `FLAT_PERCENT` (90) always. Never touch `FLAT_PERCENT` or the vault branch of `resolveBuybackRate`.
- `LOSSLESS_PERCENT = 100`, exported from `src/modules/packs/buyback-rate.ts`.
- Never write `pack.buyback_percent` from schedule code. Admin pack routes (`GET /admin/packs`, `/admin/packs/:slug`) keep returning the STORED rate.
- A pull is in a window iff `starts_at <= rolled_at < min(ends_at, cancelled_at ?? ∞)`. Display uses now.
- "All packs" (`pack_slugs = null`) = category not `free_welcome` (`FREE_WELCOME_CATEGORY` from `modules/packs/free-pack.ts`) and not `reward_box`. Pulls with `source = 'reward'` never qualify.
- Create rules: ISO strings; `ends_at > starts_at`; `ends_at > now`; `starts_at >= now − 5 min`; `pack_slugs` null or non-empty array of existing, non-free_welcome, non-reward_box slugs. `reason` via `reqReason`.
- Audit: `entity_type 'pack'`, `entity_id` = schedule id, action `create` / `disable`, `after` payload has `kind: 'lossless_schedule'`. Audit in the same transaction as the write.
- Copy: tab "Lossless Mode"; the form states "Vault sells stay at 90%." en + zhCN keys.
- No new dependencies.

## Review Focus

- Window boundary: pull rolled 1 ms before `ends_at` sold after `ends_at` still credits 100 — pinned in Task 1 (`isLossless` boundary tests) and Task 3 (http credit test).
- Cancel a LIVE schedule: pulls rolled before the cancel keep 100, after it get the pack rate — Task 1 (`effectiveEndMs` with `cancelled_at`) and Task 2 (cancel sets `cancelled_at = now`).
- Free welcome pack / reward pulls under an "All packs" window stay on their normal rate — Task 1 tests.
- Admin edit form after a window exists still shows 90 (stored), so a save never writes 100 — Task 3 http test asserts `GET /admin/packs/:slug` returns stored 90 during a live window.
- Two overlapping windows, one cancelled: pack still lossless via the other — Task 1 test.

---

### Task 1: Pure lossless decision module

**Files:**

- Modify: `backend/packages/api/src/modules/packs/buyback-rate.ts` (add `export const LOSSLESS_PERCENT = 100;` beside `FLAT_PERCENT`)
- Create: `backend/packages/api/src/modules/packs/lossless.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/lossless.unit.spec.ts`

**Interfaces:**

- Produces:
  - `type LosslessWindow = { id: string; starts_at: Date | string; ends_at: Date | string; cancelled_at: Date | string | null; pack_slugs: string[] | null }`
  - `type LosslessStatus = 'upcoming' | 'live' | 'ended' | 'cancelled'`
  - `effectiveEndMs(w: LosslessWindow): number` — `min(ends_at, cancelled_at)` in ms.
  - `losslessStatus(w: LosslessWindow, nowMs: number): LosslessStatus` — `cancelled` iff `cancelled_at <= starts_at`; else `upcoming` if `now < starts_at`, `live` if `now < effectiveEnd`, else `ended`.
  - `packEligible(w: LosslessWindow, pack: { slug: string; category: string }): boolean`
  - `isLossless(windows: LosslessWindow[], pack: { slug: string; category: string } | null | undefined, atMs: number, source?: string | null): boolean`
  - `withLossless<P extends { slug: string; category: string; buyback_percent: unknown }>(pack: P | null | undefined, windows: LosslessWindow[], atMs: number, source?: string | null): P | null | undefined` — returns `{ ...pack, buyback_percent: LOSSLESS_PERCENT }` when lossless, else the same object.

- [ ] **Step 1: Write the failing tests** (`describe('lossless')`), with `S = Date.parse('2026-10-16T16:00:00Z')`, `E = Date.parse('2026-10-18T16:00:00Z')`, `all = { id:'a', starts_at: new Date(S), ends_at: new Date(E), cancelled_at: null, pack_slugs: null }`, `gold = { slug:'gold-pack', category:'pokemon', buyback_percent: 90 }`:
  - `isLossless([all], gold, S)` → true; `S - 1` → false; `E - 1` → true; `E` → false.
  - free pack `{ slug:'welcome', category: FREE_WELCOME_CATEGORY }` and `{ slug:'rb', category:'reward_box' }` under `all` → false.
  - `isLossless([all], gold, S + 1, 'reward')` → false; `'gift'` and `'bonus'` → true.
  - `pack_slugs: ['silver-pack']` → gold false, silver true.
  - cancelled live: `{...all, cancelled_at: new Date(S + 1000)}` → `S + 999` true, `S + 1000` false; `losslessStatus(.., S + 5000)` = `'ended'`.
  - cancelled before start: `cancelled_at = new Date(S - 1)` → `losslessStatus` = `'cancelled'`, `isLossless` false at `S`.
  - overlapping `[cancelledOne, all]` → true.
  - `losslessStatus(all, S - 1)` = `'upcoming'`, `(all, S)` = `'live'`, `(all, E)` = `'ended'`.
  - `withLossless(gold, [all], S).buyback_percent` = 100 and `gold.buyback_percent` still 90 (no mutation); `withLossless(gold, [], S)` returns `gold` itself; `withLossless(undefined, [all], S)` → undefined.
  - `isLossless([all], null, S)` → false.

- [ ] **Step 2: Run to verify it fails**
      Run: `npx jest src/modules/packs/__tests__/lossless.unit.spec.ts` with `TEST_TYPE=unit` (i.e. `yarn test:unit src/modules/packs/__tests__/lossless.unit.spec.ts`)
      Expected: FAIL, cannot find module `../lossless`.

- [ ] **Step 3: Implement `lossless.ts`** per the Interfaces block. Dates via `new Date(x).getTime()`; a non-finite starts/ends makes the window never match.

- [ ] **Step 4: Run to verify it passes** — same command, all green.

- [ ] **Step 5: Commit** `feat(buyback): pure Lossless Mode window decision`

---

### Task 2: Model, migration, service methods

**Files:**

- Create: `backend/packages/api/src/modules/packs/models/lossless-schedule.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts` (register model in `MedusaService({...})`; add three methods near `createChallengeSchedule`)
- Create: migration in `backend/packages/api/src/modules/packs/migrations/` + updated `.snapshot-packs.json` (generate with `npx medusa db:generate packs`; if that needs a DB, hand-write `Migration20261017120000.ts` matching the generator's DDL and update the snapshot entry by hand)
- Test: `backend/packages/api/src/modules/packs/__tests__/lossless-schedule.integration.spec.ts`

**Interfaces:**

- Consumes: `LosslessWindow` (Task 1).
- Produces (on `PacksModuleService`):
  - model `LosslessSchedule` = `model.define('lossless_schedule', { id: model.id().primaryKey(), starts_at: model.dateTime(), ends_at: model.dateTime(), pack_slugs: model.json().nullable(), cancelled_at: model.dateTime().nullable(), created_by: model.text() })` with index `IDX_lossless_schedule_ends_at` on `ends_at` where `deleted_at IS NULL`. Generated CRUD: `listLosslessSchedules`, `createLosslessSchedules`, `updateLosslessSchedules`.
  - `losslessWindows(sinceMs: number, sharedContext?): Promise<LosslessWindow[]>` — rows with `ends_at > new Date(sinceMs)`, selecting the five window fields. (`pack_slugs` json comes back as an array or null.)
  - `createLosslessSchedule(input: { startsAt: Date; endsAt: Date; packSlugs: string[] | null; adminId: string; reason: string }, sharedContext?): Promise<{ id: string }>` — `@InjectTransactionManager()`, insert + `this.audit({ admin_id, entity_type: 'pack', entity_id: id, action: 'create', before: null, after: { kind: 'lossless_schedule', starts_at, ends_at, pack_slugs }, reason })`.
  - `cancelLosslessSchedule(input: { id: string; adminId: string; reason: string }, sharedContext?): Promise<{ id: string; cancelled_at: Date }>` — `@InjectTransactionManager()`; `SELECT ... FOR UPDATE` the row (same idiom as `editChallengeSchedule`); NOT_FOUND if missing; NOT_ALLOWED `'This schedule already ended or was cancelled.'` if `cancelled_at` set or `ends_at <= now`; set `cancelled_at = now`; audit action `'disable'`, `before` = window, `after` = `{ kind: 'lossless_schedule', cancelled_at }`.

- [ ] **Step 1: Write the failing module integration spec** (`moduleIntegrationTestRunner`, `moduleModels: [LosslessSchedule, AdminActionAudit]`, pattern of `admin-audit-atomicity.integration.spec.ts`):
  - `createLosslessSchedule` → row exists with `pack_slugs` null; one audit `{ entity_type:'pack', entity_id:id, action:'create', reason }` with `after.kind === 'lossless_schedule'`.
  - `losslessWindows(Date.now())` returns it; a row whose `ends_at` is in the past is excluded.
  - `cancelLosslessSchedule` on a live row → `cancelled_at` ≈ now, audit `'disable'`; a second cancel rejects with NOT_ALLOWED.
  - `pack_slugs: ['gold-pack']` round-trips as an array.
- [ ] **Step 2: Run** `yarn test:integration:modules src/modules/packs/__tests__/lossless-schedule.integration.spec.ts` → FAIL (model missing).
- [ ] **Step 3: Implement** model, registration, migration + snapshot, three service methods.
- [ ] **Step 4: Run** the same → PASS. Also `npx tsc --noEmit -p .` clean.
- [ ] **Step 5: Commit** `feat(buyback): lossless_schedule table and service`

---

### Task 3: Apply the overlay at every pricing and display site

**Files (modify):**

- `backend/packages/api/src/workflows/steps/buyback-pull.ts:119-140` — after loading `pack`: `const windows = await packs.losslessWindows(new Date(pull.rolled_at).getTime());` then pass `withLossless(pack, windows, new Date(pull.rolled_at).getTime(), pull.source)` to `resolveBuybackRate`.
- `backend/packages/api/src/modules/packs/service.ts` `quoteBuyback` — add optional 5th param `source?: string | null`; overlay at `rolled_at` the same way. Existing callers unchanged (task-spin reward_box packs are excluded by category).
- `backend/packages/api/src/api/store/vault/route.ts` — load `windows = await packsService.losslessWindows(Date.now() - revealGraceMs())` once per request; per pull `withLossless(pack, windows, rolledAtMs, p.source)`.
- `backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts` — same as vault.
- `backend/packages/api/src/api/store/packs/route.ts` and `src/api/store/packs/[slug]/route.ts` — leave the cached body untouched; in `GET`, after obtaining the body (cached or fresh), respond with a copy whose `buyback_percent` is overlaid at `Date.now()` using `losslessWindows(Date.now())` (needs `category` and `slug` — both already in the body). Do not cache the overlaid copy.
- Test: `backend/packages/api/integration-tests/http/lossless-schedule.spec.ts` (shared with Task 4; this task writes the pricing cases)

**Interfaces:**

- Consumes: `withLossless`, `losslessWindows` (Tasks 1–2), `revealGraceMs` from `buyback-rate.ts`.

- [ ] **Step 1: Write failing http cases** (`medusaIntegrationTestRunner({ inApp: true })`, fixtures like `config-audit.spec.ts` / `vault-buyback.spec.ts`: a `pokemon` pack at `buyback_percent: 90`, a card, a customer pull). Insert windows via `packs.createLosslessSchedule` directly:
  - live "all" window: `GET /store/packs` shows the pack at 100; `GET /store/packs/:slug` 100; `GET /admin/packs/:slug` (admin auth) still 90.
  - instant sell of a pull rolled inside the window (fresh `rolled_at`, `revealed_at` now) credits `value × 100%`.
  - same pull after `instant_closed_at` is stamped (vault) credits 90%.
  - live window cancelled at T: a pull rolled before T and sold inside its instant window credits 100%; a pull rolled after T credits the pack rate (90%).
  - no window: everything 90.
- [ ] **Step 2: Run** `yarn test:integration:http lossless-schedule.spec` → FAIL.
- [ ] **Step 3: Implement** the six call-site changes.
- [ ] **Step 4: Run** the new spec → PASS; then the buyback regression set: `yarn test:integration:http vault-buyback.spec ledger-buyback.spec pack-open-charge.spec` → PASS; `yarn test:unit` → PASS.
- [ ] **Step 5: Commit** `feat(buyback): price instant sells and pack badges through Lossless windows`

---

### Task 4: Admin API

**Files:**

- Create: `backend/packages/api/src/api/admin/lossless-schedules/route.ts` (GET, POST)
- Create: `backend/packages/api/src/api/admin/lossless-schedules/[id]/cancel/route.ts` (POST)
- Create: `backend/packages/api/src/api/admin/lossless-schedules/validate.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` — `adminActionRateLimit` on `POST /admin/lossless-schedules` and `POST /admin/lossless-schedules/*` (next to the challenge schedule entries)
- Test: `backend/packages/api/src/api/admin/lossless-schedules/__tests__/validate.unit.spec.ts`; extend `integration-tests/http/lossless-schedule.spec.ts`

**Interfaces:**

- Consumes: Task 1 `losslessStatus`, `effectiveEndMs`; Task 2 service methods.
- Produces:
  - `parseLosslessSchedule(body: unknown, nowMs: number): { startsAt: Date; endsAt: Date; packSlugs: string[] | null }` (shape checks + time rules; slug existence is checked in the route against `listPacks`).
  - `LosslessScheduleView = { id; starts_at: string; ends_at: string; effective_end: string; pack_slugs: string[] | null; cancelled_at: string | null; created_by: string; status: LosslessStatus }`
  - `GET` → `{ schedules: LosslessScheduleView[] }`, `starts_at DESC`, cap 100.
  - `POST` → `{ schedule: LosslessScheduleView }`. Slug check: `listPacks({ slug: packSlugs })`; every slug found and none `free_welcome`/`reward_box`, else INVALID_DATA `Unknown or ineligible pack: <slug>`.
  - `POST /:id/cancel` → `{ schedule: LosslessScheduleView }`.

- [ ] **Step 1: Failing unit spec for `parseLosslessSchedule`** (`now = Date.parse('2026-10-17T00:00:00Z')`): valid → dates parsed, `pack_slugs` null passes through; missing/invalid ISO → INVALID_DATA; `ends_at <= starts_at` → INVALID_DATA; `ends_at <= now` → INVALID_DATA; `starts_at = now − 5 min` OK, `now − 5 min − 1 ms` → INVALID_DATA; `pack_slugs: []` → INVALID_DATA; non-string entries → INVALID_DATA; duplicates de-duplicated.
- [ ] **Step 2: Run** `yarn test:unit src/api/admin/lossless-schedules` → FAIL.
- [ ] **Step 3: Implement** validate + routes + middleware entries.
- [ ] **Step 4: Extend http spec**: POST (super-admin via `mintSuperAdmin`) → 200 + audit row; POST with `reason` missing → 400; unknown slug → 400; GET lists it `live`; cancel → `ended`; cancel again → 400 (NOT_ALLOWED maps to 400). This run also proves the migration applies on a fresh DB. Run `yarn test:integration:http lossless-schedule.spec` → PASS.
- [ ] **Step 5: Commit** `feat(admin): Lossless Mode schedule API`

---

### Task 5: Admin UI — "Lossless Mode" tab

**Files:**

- Modify: `backend/apps/admin/src/lib/packs-api.ts` — add `LosslessSchedule` type (= `LosslessScheduleView`) and facade entries for `admin['lossless-schedules'].query/mutate` and `admin['lossless-schedules'].$id.cancel.mutate`.
- Create: `backend/apps/admin/src/routes/packs/LosslessTab.tsx` — table + create modal + cancel confirm.
- Modify: `backend/apps/admin/src/routes/packs/page.tsx` — third `Tabs.Trigger value="lossless"` / `Tabs.Content`; hide the status filter and "New pack" button on that tab.
- Modify: `backend/apps/admin/src/i18n/en.json`, `zhCN.json` — `packs.tabs.lossless` and a `packs.lossless.*` block.
- Test: `backend/apps/admin/src/lib/lossless.test.ts` for `packsLabel(slugs: string[] | null, titleBySlug: Map<string, string>): string` ("All packs" or comma-joined titles, unknown slug shown raw) — put `packsLabel` in `backend/apps/admin/src/lib/lossless.ts`.

Behavior:

- Table columns: Start, End (both `describeInShopZone(d, 'Asia/Kuala_Lumpur')`), Packs (`packsLabel`), Status badge (upcoming=blue, live=green, ended=grey, cancelled=grey), action "Cancel" on upcoming/live → `RowActionConfirm`-style confirm with reason.
- Create modal: Start / End `datetime-local` (default start = `toLocalInput(now)`, end blank), MYT preview under each via `describeInShopZone`, "All packs" switch default on; off shows checkboxes of packs from the existing `usePacks` list filtered to category not `free_welcome`/`reward_box`; reason textarea; note "Vault sells stay at 90%."; Save disabled until end > start and reason non-empty. On success invalidate the list query.

- [ ] **Step 1: Failing vitest** for `packsLabel`. Run `npx vitest run src/lib/lossless.test.ts` → FAIL.
- [ ] **Step 2: Implement** `lib/lossless.ts`, facade, tab, page wiring, i18n.
- [ ] **Step 3: Run** `npx vitest run` (admin) → PASS; `npx tsc --noEmit -p .` (admin) → clean; `npx vite build` → succeeds.
- [ ] **Step 4: Commit** `feat(admin): Lossless Mode tab on the Packs page`

---

### Task 6: Ship

- [ ] Full checks: backend `yarn test:unit`, `npx tsc --noEmit -p .`; admin vitest + tsc.
- [ ] Push branch, open PR to `master` (body: why, overlay design, vault untouched, rollout steps). Enable auto-merge while checks run.
- [ ] After deploy: `curl` the public `store/packs` (still 100, hand-set) and `GET /admin/lossless-schedules` responds.
- [ ] Rollout per spec: create window start = now − 5 min, end = 2026-10-19T00:00 MYT, All packs; confirm `store/packs` 100; set the 7 packs' normal rate to 90 in admin; confirm `store/packs` still 100 and admin edit form shows 90.
- [ ] Monday after 00:00 MYT: confirm `store/packs` shows 90 for all 7.
