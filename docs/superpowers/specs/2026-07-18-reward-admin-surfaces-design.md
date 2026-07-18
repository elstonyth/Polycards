# Reward Admin Surfaces — Design Spec

- **Date:** 2026-07-18 (revised 2026-07-19 after two-agent review)
- **Status:** Approved design — review amendments folded in
- **Author:** brainstorming session (Claude + Elston)
- **Branch:** `claude/reward-admin-surfaces-handoff-2dfed2`
- **Predecessor:** `2026-07-18-vip-leaderboard-redesign-design.md` (PR #207, sub-projects
  A+B+C). This spec covers the **admin surfaces** follow-up; it does **not** build
  sub-project D (the Weekly Challenge runtime).

---

## 1. Context & scope decisions

Polycards has two independent reward systems (never conflate them):

- **VIP Reward** — per-user 100-level ladder. Backend fully built; ladder rows live in
  the `vip_level` table (seeded from `vip-levels.data.ts`) but there is **no admin UI
  or API for the ladder itself**. The existing `daily-rewards` admin page configures
  only boxes / voucher ranges / frames / engine settings.
- **Leaderboard "Weekly Pulled Value Challenge"** — deferred sub-project D. **No
  backend exists.** Its runtime (snapshot column, re-rank, pool, weekly settlement,
  top-10 payout) is explicitly out of scope here.

**Decided scope for this project** (brainstormed 2026-07-18/19):

1. **VIP ladder admin** — a new **Levels tab on the merged "VIP" admin page**
   (backed by a new `/admin/vip-levels` API) with **full CRUD**
   (edit fields *and* add/remove rungs; the ladder becomes variable-length).
   The redundant **Vouchers tab is removed** (see §3.5 — it dual-writes the same
   column and is hard-locked to 100 levels).
2. **Challenge config layer** — inert config a future D reads. Three groups, all
   admin-editable, none of which move money or trigger settlement:
   - **Milestone stages** — full CRUD (variable count, not fixed at 4; D must render N
     stages). Threshold + per-stage rewards (credits + featured cards).
   - **Week config** — **fixed calendar weeks**: configurable IANA timezone (default
     `Asia/Kuala_Lumpur`), reset day (default Monday) and reset hour (default 00:00).
     Not rolling-window.
   - **Top-10 weekly reward** — **flat**: one reward definition applied to every
     top-10 finisher (credits + featured cards). Not per-rank, not banded.

**Deferred to D (this project must NOT build):** `pulled_value_myr` snapshot column,
`leaderboardTop` re-rank, community-pool aggregation, week close/settlement, the actual
payout (idempotency-critical), and any storefront challenge UI.

**PR #207 dependency note:** the storefront behaviors cited in §3.1/§3.4 (carousel
clamp, tier-diff benefits) were verified on the unmerged PR #207 branch. The admin
work in this spec does not depend on #207's code, but final browser verification of
storefront graceful-degradation assumes #207 is merged first.

---

## 2. Shared architecture decisions

- **Config lives in the `packs` module.** Both surfaces add models/service methods to
  `backend/packages/api/src/modules/packs/` — the VIP ladder already lives there and D
  will extend the packs pull/leaderboard logic. No new Medusa module.
- **Two whole-set replaces + one singleton patch.** The two *collection* editors
  (VIP ladder, challenge stages) POST the **whole set**; the server validates
  cross-row invariants atomically (contiguity, strictly-increasing thresholds) and
  replaces — per-row writes would make those invariants race-prone. The *singleton*
  (`challenge_settings`) takes an audited **partial patch**, like
  `editSiteSettings`/`editRewardsSettings`. Precedents: `avatar-frames` (whole
  catalog), `daily-rewards/vouchers` (whole ladder), `daily-rewards/boxes/:tier`
  (whole prize list per tier).
- **Naming:** whole-set replaces use `save*` (`saveVipLevels`,
  `saveChallengeStages`); the singleton uses `edit*` (`editChallengeSettings`) —
  consistent verbs per operation shape, and none shadow the MedusaService
  auto-generated `create*/update*/delete*` CRUD methods.
- **Audited writes** (pattern of `editRewardsSettings` / `editSiteSettings` /
  `editAvatarFrames` in `service.ts`): `adminId` from `req.auth_context.actor_id`
  (never the body), a required `reason` via the shared `reqReason` helper
  (non-empty trimmed string; same length rule as existing surfaces), before/after
  snapshots written with `createAdminActionAudits`. Audit identifiers:
  `entity_type`/`action` = `('vip_levels', 'replace')`,
  `('challenge_stages', 'replace')`, `('challenge_settings', 'edit')`.
- **Replace mechanics (both collections): diff-upsert keyed on the unique natural
  key** (`vip_level.level`, `challenge_stage.stage_number`) — update surviving rows
  in place (ids preserved), create new rows, **hard-delete** removed rows. Soft
  delete is NOT usable here: a soft-deleted row would still hold the unique
  `level`/`stage_number` value and collide with a recreated one on the next save.
  Fields not present in the input (e.g. `vip_level.prizes`) are left untouched on
  surviving rows and `null` on new rows.
- **Admin frontend conventions** (per existing routes): page at
  `backend/apps/admin/src/routes/<name>/page.tsx` with `export const config:
  RouteConfig` (from `@mercurjs/dashboard-sdk`) for the sidebar; `@medusajs/ui`
  components; React Query hooks in `admin/src/lib/queries.ts`; REST helpers in
  `admin/src/lib/admin-rest.ts`; `LoadingSkeleton`; `toast` + `usePrompt` for
  save/confirm flows.
- **Error contract:** validators throw `MedusaError` `INVALID_DATA` with a message
  naming the offending row/field (e.g. `"level 7: spend_threshold must exceed level
  6's"`) → HTTP 400. The UI surfaces the server message in a `toast` (parity with
  existing tabs); the Levels/Stages editors additionally run the same checks
  client-side pre-save to catch errors inline before POSTing.
- **Sidebar organization — exactly one top-level entry per reward system**
  (operator-friendliness). **Neither lives under Promotions:**
  - **VIP system → one page, "VIP":** the existing daily-rewards page is renamed
    **"Daily Rewards" → "VIP"**, un-nested from `/promotions`, and restructured to
    **four tabs: Levels, Boxes, Frames, Engine** (new Levels tab first — the ladder
    is the system's overview; Vouchers tab removed per §3.5). There is **no separate
    `/vip-levels` sidebar route** (the *API* path `/admin/vip-levels` still exists —
    only the UI is merged).
  - **Milestone system → one page, "Weekly Challenge":** a top-level sidebar item
    ranked directly after VIP, with tabs **Milestone Stages** and **Week & Payout**.
  - **Ranks & icons:** VIP `rank: 30` + `Star` icon; Weekly Challenge `rank: 31` +
    `Trophy` icon (both from `@medusajs/icons`; adjust rank integers at
    implementation if they collide with existing entries — requirement is only
    "adjacent, VIP first").

---

## 3. Surface 1 — VIP ladder admin

### 3.1 Backend

**No model change.** `vip_level` already has every field
(`level`, `spend_threshold`, `voucher_amount`, `box_tier`, `frame_unlock`,
`direct_referral_pct`, `prizes`). Verified variable-length-safe end to end:

- `levelForSpend()` (`vip-ladder.ts`) iterates whatever DB rows exist — no 100
  assumption (it throws on an *empty* ladder, hence the N ≥ 1 invariant below).
- `rewardsForLevel()` (`vip-rewards.ts`) **snapshots values into each grant**, so
  ladder edits affect only *future* level-ups; granted rewards stay frozen.
- Draw-time box tier resolves from the DB row (`resolveBoxTier` →
  `vipLevel?.box_tier ?? ''`), not a formula.
- Storefront (PR #207 branch): `vip-benefits.ts` derives box upgrades by **diffing
  consecutive tiers**; the carousel clamps a missing `highest_level_ever` to index 0;
  tier labels render generically (`Tier ${letter.toUpperCase()}`).

**Money units:** `spend_threshold` and `voucher_amount` are stored in **MYR** (RM)
— confirmed by the model comment, the seed (3,000,000 = RM3M at L100) and
`levelForSpend`'s internal `toSen()` conversion for comparison only. The Levels tab
displays and submits **RM with no conversion**; sen never crosses the admin wire.

**New API** — `backend/packages/api/src/api/admin/vip-levels/route.ts`:

- `GET` → `{ levels: VipLevelDTO[] }` (full ladder, ordered by `level`).
- `POST` body (exact shape):

  ```jsonc
  {
    "levels": [
      {
        "level": 1,                  // explicit; server validates contiguity 1..N
        "spend_threshold": 0,        // MYR
        "voucher_amount": 0,         // MYR
        "box_tier": "a",
        "frame_unlock": false,
        "direct_referral_pct": 1
      }
      // ... one entry per rung; no id, no prizes on the wire
    ],
    "reason": "why this change"
  }
  ```

  → validate → audited diff-upsert replace (§2) → returns the saved ladder.

**New service method** `saveVipLevels({ levels, adminId, reason })` +
**pure validator** `validateVipLevels()` in its own file
(`modules/packs/vip-levels-validate.ts`), unit-tested. (The `box_tier`-exists check
is a service-level DB lookup, not part of the pure validator.)

**Invariants (server-enforced):**

- **Non-empty ladder:** N ≥ 1 (`levelForSpend` throws on an empty ladder).
- `level` values are **contiguous `1..N`** (POST = the full renumbered ladder; the
  server rejects gaps/duplicates). No fixed upper bound.
- `spend_threshold` strictly increasing; **rung 1's threshold must be `0`**
  (`levelForSpend`'s defensive floor).
- `box_tier` must be one of the existing `reward_box` tiers (else that tier's
  daily-box draw silently returns `'unavailable'` and the customer gets no box).
  Service-level check against live `reward_box` rows.
- `frame_unlock = true` only on decade levels 10, 20 … 100 (§3.2).
- `voucher_amount` ≥ 0, `direct_referral_pct` ≥ 0.
- `prizes` JSON is not surfaced or edited (unused; out of scope).

### 3.2 Avatar-frame constraint (decided 2026-07-18)

`rewardsForLevel()` grants an avatar frame for **any** rung with `frame_unlock:
true`, but the frame-milestone list `[10, 20 … 100]` is hardcoded as `FRAME_LEVELS`
in **three places** (verified — exactly three definitions, all other consumers import
one of them): backend catalog validation (`modules/packs/avatar-frames.ts`, also
used by `editAvatarFrames`'s normalization loop), the admin daily-rewards Frames tab
(its own local copy), and the storefront (`src/lib/frame-levels.ts`, used by both
the `/me` appearance picker and the `setAvatarFrame` server action's equip
validation). An unconstrained `frame_unlock` would therefore grant frames the
storefront refuses to equip — a half-broken state.

**Decision — constrain, don't cascade:** the vip-levels validator requires
`frame_unlock = true` **only on the classic decade levels (10, 20 … 100)**;
`frame_unlock` on any other level is rejected with a clear error. All three
hardcoded lists stay as they are. **Intended consequence:** a ladder grown past
level 100 can never carry frames above 100 — decade rungs like 110/120 simply have
no frame; this is accepted, not a bug. Making frame milestones ladder-driven
end-to-end is a **documented follow-up**, not part of this project.

### 3.3 Frontend — the Levels tab

The ladder editor is a new **Levels tab** on the existing daily-rewards page
(renamed "VIP", §2) — built as its own component file
`backend/apps/admin/src/routes/daily-rewards/vip-levels-tab.tsx` that `page.tsx`
imports and wires as the first tab. The page file is already ~1,330 lines (over
the repo's 800-line guideline), so the tab component owns all Levels UI and state;
`page.tsx` changes only by the tab registration and the Vouchers-tab removal (§3.5).

- `@medusajs/ui` `Table` of editable rows (level, threshold RM, voucher RM, box tier
  select, frame toggle, referral %). **All rows rendered — no
  pagination/virtualization** (~100 lightweight rows is fine).
- **Box-tier select source:** the existing `useDailyBoxes` hook
  (`GET /admin/daily-rewards/boxes`) supplies the live tier list — no new endpoint.
- **Row editing model:** the table is an **ordered list**; `level` is derived as
  `index + 1` and renumbered automatically on any structural change. Controls:
  per-row **insert above / insert below**, per-row **delete**, and **append** at the
  end. No drag-reorder (ordering is expressed through thresholds). Row 1's
  threshold input is **locked to 0**.
- **Renumbering does not auto-mutate row contents:** deleting/inserting shifts
  level numbers only. If a shift strands `frame_unlock` on a non-decade level or
  breaks threshold monotonicity, the client-side pre-validation (§2 error contract)
  flags the affected rows inline and blocks save until the operator resolves them.
- Dirty-state tracking against the loaded snapshot; save opens a confirm with a
  **required reason** field; `toast` on result.
- Hooks `useVipLevels` / `useSaveVipLevels` in `lib/queries.ts`; REST in
  `lib/admin-rest.ts`.

### 3.4 Documented edge cases (accepted, no code)

- **Ladder shrink vs `highest_level_ever`:** the marker is monotonic, so deleting top
  rungs leaves some users' recorded peak above the ladder max. Verified graceful:
  `levelForSpend` recomputes the live level from the current ladder; the store `/vip`
  route's `next` lookup returns `null` (treated as ladder top); the carousel falls
  back to index 0. Do **not** "fix" this — grants and peaks are historical facts.
  *(Post-review amendment, 2026-07-19: this list missed `resolveBoxTier`, whose
  exact-level lookup went permanently `'unavailable'` for members peaked above a
  shrunken ladder. It now clamps to the top rung at read time — historical rows
  are still never mutated.)*
- **Seed reappearance:** `seed.ts` / `seed-vip-achievements.ts` are idempotent
  upsert-if-absent **by `level`** — they never overwrite operator edits, but a
  *deleted* rung whose level number is in `VIP_LEVELS` reappears if a seed re-runs.
  Accepted: seeds are manual/first-boot operations.
- **Workbook pin test** (`vip-levels-workbook.unit.spec.ts`) pins the **seed data
  file**, not DB rows. Runtime admin edits don't touch it. It stays as-is.
- **Renumbering semantics:** existing `vip_reward_grant` rows keep their snapshotted
  level numbers even if the ladder is renumbered — frozen by design; likewise
  `vip_member_state.current_level`/`highest_level_ever` are level *numbers*, not
  FKs, and the diff-upsert keys on `level`, so nothing is orphaned. No migration of
  historical data.

### 3.5 Vouchers tab removal (review finding, decided 2026-07-19)

The Vouchers tab and the new Levels tab **write the same column**
(`vip_level.voucher_amount`) — a dual-write conflict — and the voucher-ranges
machinery is **hard-locked to exactly 100 levels** (`voucher-ranges.ts` `LEVELS =
100`; `foldRanges` rejects any coverage ≠ 1–100). A variable-length ladder would
brick its save (shrink) or strand rungs 101+ (grow).

**Decision — remove the Vouchers tab UI.** Per-rung voucher editing in the Levels
tab supersedes the range editor. Removal scope:

- Delete the Vouchers tab from `page.tsx` (and its local helpers
  `daily-rewards/voucher-ranges.ts` + test if nothing else imports them).
- The backend `GET/POST /admin/daily-rewards/vouchers` route and
  `saveVoucherRanges` service method **stay in place but become unused** by the
  admin UI (removing them is backend cleanup beyond this project's need; note as
  follow-up). Nothing else calls them.

---

## 4. Surface 2 — Challenge config layer

### 4.1 Models (new, in `packs`; one additive migration)

**`challenge_stage`** — one row per milestone stage:

| field | type | notes |
|---|---|---|
| `id` | id (pk) | |
| `stage_number` | number | contiguous from 1; unique |
| `threshold_myr` | bigNumber | community-pool cumulative threshold, **MYR** |
| `reward_credits` | bigNumber | stage reward, **MYR credited as store credits (1 RM = 1 credit)**; ≥ 0 |
| `reward_card_ids` | json | array of featured `card` **ids**; may be empty |

**`challenge_settings`** — singleton (same pattern as `site_settings`: one row,
create-on-first-edit, fixed `id: 'global'`; the migration adds a
**`CHECK (id = 'global')`** constraint like site_settings' to make the singleton
race-safe):

| field | type | default | notes |
|---|---|---|---|
| `id` | id (pk) | `'global'` | CHECK-constrained |
| `cadence` | text | `'fixed_weekly'` | only valid value today; enum-checked |
| `timezone` | text | `'Asia/Kuala_Lumpur'` | must be a valid IANA zone |
| `reset_day` | number | `1` (Monday) | 0–6 |
| `reset_hour` | number | `0` | 0–23 |
| `payout_credits` | bigNumber | `0` | flat top-10 reward, same unit as `reward_credits`; ≥ 0 |
| `payout_card_ids` | json | `[]` | flat top-10 featured cards (card ids) |

Both registered in `PacksModuleService`'s `MedusaService({...})` model list; table
DDL via one raw-SQL migration (repo pattern).

### 4.2 APIs

- `GET/POST /admin/challenge/stages` — whole-set audited replace
  (`saveChallengeStages({ stages, adminId, reason })`). POST body:

  ```jsonc
  {
    "stages": [
      {
        "stage_number": 1,           // explicit; server validates contiguity
        "threshold_myr": 10000,
        "reward_credits": 100,
        "reward_card_ids": ["card_123"]
      }
    ],
    "reason": "why"
  }
  ```

- `GET/POST /admin/challenge/settings` — audited **singleton patch**
  (`editChallengeSettings({ patch, adminId, reason })`). POST body:
  `{ "patch": { /* any subset of the §4.1 fields except id */ }, "reason": "why" }`
  — only present fields are validated and written.

**Validation:**

- Stages (pure validator `validateChallengeStages`): `stage_number` contiguous from
  1; `threshold_myr` strictly increasing; `reward_credits` ≥ 0; card-id array shape.
  **Card existence** (`reward_card_ids` ⊆ `card` table) is a **service-level DB
  check** at save time — admin typos can't create dangling featured-card references.
- Settings (pure validator for shape/ranges + service-level card check): `cadence`
  ∈ `{'fixed_weekly'}`; timezone validated via `Intl.supportedValuesOf('timeZone')`
  membership; `reset_day` 0–6; `reset_hour` 0–23; `payout_credits` ≥ 0;
  `payout_card_ids` same card-existence check.
- **Empty stage list is valid** and means "challenge unconfigured/disabled" — D must
  treat zero stages as challenge-off. (Contrast: the VIP ladder requires N ≥ 1.)
- **`GET /admin/challenge/settings` before first save returns the §4.1 defaults**
  (create-on-first-edit; never 404s).
- Card existence is checked **at save time only**; a featured card deleted *later*
  leaves a dangling id. D must skip missing ids at render (documented in §4.4).

### 4.3 Frontend

`backend/apps/admin/src/routes/challenge/page.tsx` — **top-level** sidebar entry
"Weekly Challenge" (see §2 sidebar organization), two `@medusajs/ui` `Tabs`:

- **Milestone Stages** — editable table (stage #, threshold RM, credits, featured
  cards); add/remove stage rows with the same ordered-list/renumber model as the
  Levels tab (§3.3, minus the row-1-zero rule). The featured-card picker **adapts**
  the daily-box prize editor's card-list `FocusModal` — that picker emits
  `product_handle`; this one must emit **`card.id`** (§4.1 stores ids, not handles).
- **Week & Payout** — week cadence (read-only `fixed_weekly` for now), timezone
  select, reset day/hour, and the flat top-10 reward (credits + featured cards).

Both tabs save independently with required reason; same query-hook/REST and error
conventions (§2).

### 4.4 Contract note for D

These tables are **inert** until D consumes them. D's spec must treat them as the
config contract: variable stage count (render N, don't assume 4; **zero stages =
challenge disabled**), flat top-10 reward, fixed-weekly cadence anchored at
(`timezone`, `reset_day`, `reset_hour`), `reward_credits`/`payout_credits` in MYR
granted as store credits, and **skip `reward_card_ids` / `payout_card_ids` entries
whose card no longer exists**. If D's settlement design needs a different shape
(e.g. per-rank payouts), it amends this schema in its own migration — this project
does not pre-build for that.

---

## 5. Security

- All routes under `/admin/*` — framework-auto-protected; `adminId` from
  `auth_context.actor_id`, never the body.
- Every write requires a `reason` and lands an `AdminActionAudit` row with
  before/after snapshots (§2 audit identifiers).
- No money moves in this project, but the config **governs** future money (voucher
  amounts, stage/payout rewards) — run **`/security-review`** on all new write paths
  before completion. Payout settlement idempotency is D's concern, not this project's.
- **Accepted trade-off — no optimistic concurrency:** concurrent admin edits are
  last-write-wins (no version/`If-Match` check). No existing admin surface in this
  repo has one and this is a single-operator shop. Revisit if a second operator
  materialises; the audit trail records both writes meanwhile.

---

## 6. Testing & verification

- **Unit** (`validateVipLevels`, `validateChallengeStages`, settings validator) —
  one case per invariant: level gaps / duplicates / empty ladder; non-increasing
  thresholds; nonzero first threshold; `frame_unlock` on non-decade and >100
  levels (accepts 10…100); negative `voucher_amount` / `direct_referral_pct` /
  `reward_credits` / `payout_credits`; stage-number gaps; invalid `cadence`; bad
  timezone; `reset_day`/`reset_hour` out of range; malformed card-id arrays.
- **Integration** (backend `integration-tests/http/`, `medusaIntegrationTestRunner`
  + `mintSuperAdmin`): new admin routes — 401 unauthenticated; GET shapes
  (settings GET returns defaults pre-save); POST happy path persists + writes an
  audit row; POST invariant violations reject with 400 and change nothing
  (atomicity); unknown `box_tier` and dangling card ids rejected (needs seeded
  `card` rows). **Fixtures:** the runner truncates between tests — re-seed the VIP
  ladder (`VIP_LEVELS`), the 11 `reward_box` rows, and test `card` rows in setup,
  as `daily-vouchers.spec.ts` does.
- **Replace-mechanics regression:** save → delete a rung → save again succeeds (no
  soft-delete unique collision on `level`); surviving rows keep ids and `prizes`.
- **Type gate:** repo PostToolUse + Stop typecheck hooks (storefront + backend green).
- **Browser verification:** admin on `:7000` against the **worktree** backend on
  `:9000` (per the handoff caveat: kill the main-tree `:9000` backend first, copy env
  via PowerShell `Copy-Item`). Exercise both pages end-to-end: load, edit,
  insert/delete rows, save with reason, reload persists; confirm the Vouchers tab is
  gone and Boxes/Frames/Engine still work.

---

## 7. Out of scope

- All of sub-project D's runtime (snapshot column, re-rank, pool, weekly buckets,
  settlement, payout, Task-hub UI).
- Editing `vip_level.prizes` (unused JSON, null throughout the seed).
- The VIP page's remaining tabs (Boxes / Frames / Engine) and the avatar-frames
  validator — behavior unchanged. The page gains the Levels tab, loses the Vouchers
  tab (§3.5), and updates its `RouteConfig` (label → "VIP", un-nest, rank; §2).
  Frame milestones stay fixed per §3.2; ladder-driven frames are a documented
  follow-up.
- Backend removal of the now-unused `/admin/daily-rewards/vouchers` route +
  `saveVoucherRanges` (documented follow-up cleanup, §3.5).
- Seed-file changes (`vip-levels.data.ts`) and the workbook pin test.
- Optimistic-concurrency/versioning on admin writes (documented trade-off, §5).
