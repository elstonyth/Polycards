# Plan 116: Make every cache comment true for a two-instance deployment, and document the staleness ladder

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- backend/packages/api/src/api/admin/packs backend/packages/api/src/api/store/packs backend/packages/api/src/api/store/leaderboard/route.ts backend/packages/api/src/api/store/pulls/recent/route.ts src/app/leaderboard/page.tsx src/lib/data/leaderboard.ts src/lib/ttl-cache.ts`
> On any in-scope change since `30eded61`, compare the "Current state"
> excerpts before proceeding; on a mismatch, treat as STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (comment/documentation edits + one code-free decision record)
- **Depends on**: none
- **Category**: docs + tech-debt (correctness of documented invariants)
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

PR #473 set BOTH DigitalOcean apps to `instance_count: 2` (verified:
`git log -S "instance_count: 2" -- .do/backend.app.yaml` returns only
`30eded61`). Every backend read cache is a **per-process** `Map`, and every
admin pack write busts only the Maps **in the process that took the
write**. Three route files carry the sentence _"Upgrade to Redis only if we
ever run >1 instance"_ — that trigger condition is now true and nothing
happened. Concretely:

- An admin edits a pack price. The write lands on backend instance A and
  busts A's Maps. Instance B serves the old price for up to 30s. Because
  the load balancer round-robins, the admin sees new → old → new
  ("flapping"), the classic "my edit didn't save" report, and the four
  write-path comments promising the edit "shows IMMEDIATELY" are now false
  on ~half of reads.
- On the storefront side, `src/app/leaderboard/page.tsx` still says the
  page is "rendered per-request so it always reflects the current ledger"
  — false since #473 memoised `getLeaderboard` (30s) and
  `getAvatarFrames` (60s).
- Nobody has written down the total worst-case staleness. It stacks:
  backend TTL (30s, per instance) + storefront TTL (30s, per instance) +
  home route cache (15s) ≈ **75s** for `/`, ≈105s for a home chase card
  (60s `getPackChase` layer). An operator debugging "old price still up"
  has no document that adds those up.

**OPERATOR DECISION GATE — read before executing.** This plan has two
possible shapes and the advisor RECOMMENDS the first; the operator picks:

- **(A) Document-the-truth (recommended, this plan's Steps).** Accept the
  bounded cross-instance staleness, fix every comment that now lies, and
  write down the staleness ladder. Rationale: every layer is TTL-capped at
  ≤60s, all cached bodies are display-only (each purchase/spin path
  re-checks live state — the route comments say so), admin edits are rare,
  and a Redis pub/sub bust adds a moving part to money-adjacent write
  paths to shave a ≤30s cosmetic window. Effort S, risk LOW.
- **(B) Restore immediacy via Valkey pub/sub.** Publish a `packs:bust`
  message from `bustPackCaches()` on the existing `REDIS_URL` ioredis
  client; each API process subscribes at boot and clears its local Maps on
  receipt (degrades to today's TTL when Redis is down). This HONORS the
  three route comments' own recorded trigger — _"Upgrade to Redis only if
  we ever run >1 instance"_ — which #473 tripped. Effort M, risk MED (adds
  a Redis dependency to a write path that has none today). If the operator
  chooses (B), the comment edits below still apply (they document the new
  mechanism instead of accepting the lag), and the Maintenance-notes sketch
  becomes the implementation — do that as a SEPARATE plan, not inline here.

**Default if no operator input: (A).** The three "Upgrade to Redis only
if…" sentences are the team's own recorded trigger, so (A) must not delete
them silently — it converts each into an explicit "condition tripped;
per-process accepted, see plan 116" record (Step 2), which is a decision,
not a reversal-by-fiat. The rest of this plan assumes (A). Rationale for
the recommendation: every layer is TTL-capped, display-only, admin edits
rare; the pub/sub in (B) trades real write-path complexity for a ≤30s
cosmetic win. If operators later report edit-flapping pain in practice,
the recorded upgrade path is the Redis pub/sub bust channel on the
existing `REDIS_URL` client (see Maintenance notes) — not
Redis-backed caches.

## Current state

Backend files (all under `backend/packages/api/src/api/`), each with a
per-process Map cache and/or a bust call:

1. `store/packs/route.ts:13-22` — 30s `listCache`; comment ends
   _"Upgrade to Redis only if we ever run >1 instance."_
2. `store/packs/[slug]/route.ts:30-38` — 30s `packCache`; comment ends
   with the same Redis sentence.
3. `store/leaderboard/route.ts:33-35` — 30s `boardCache`; same Redis
   sentence ("…grows with total pull history; upgrade to Redis if we ever
   run >1 instance.").
4. `store/pulls/recent/route.ts:38-41` — 5s `recentCache` (no Redis
   sentence; short TTL).
5. `admin/packs/route.ts:30-58` — 30s admin `listCache`;
   `clearAdminPackListCache` at :58; a comment at :34-35 states the
   invariant "Every admin pack write busts it".
6. `admin/packs/[slug]/route.ts:13-21` — `bustPackCaches()`:
   ```ts
   // Bust the 30s read caches (storefront list + detail, and the admin pack list)
   // so an admin pack edit (price/status/stock/published-odds) shows IMMEDIATELY
   // instead of ≤30s later. …
   ```
7. `admin/packs/reorder/route.ts:20-24` — "bust the 30s read caches so the
   new order shows immediately, same as every other admin pack write."
8. `admin/packs/[slug]/odds/route.ts:299-305` — busts detail + admin list;
   comment: "…the operator saves odds here, returns to the list they came
   from, and reads their pre-edit numbers for up to 30s."

Storefront files:

9. `src/app/leaderboard/page.tsx:9-12`:
   ```tsx
   // Live leaderboard + Weekly Pulled Value Challenge, aggregated from the gacha
   // Pull ledger. Fetched server-side (the storefront origin can reach the backend;
   // the browser is CORS-blocked) and rendered per-request so it always reflects
   // the current ledger.
   ```
   False since #473: `getLeaderboard` memoised 30s
   (`src/lib/data/leaderboard.ts:65` area), `getAvatarFrames` 60s.
10. `src/lib/data/leaderboard.ts:55-57` — doc opens "Live leaderboard for
    a period…".
11. `src/lib/ttl-cache.ts:1-18` — the header explains per-process caching
    but carries no staleness ladder.

## Commands you will need

| Purpose              | Command                                      | Expected |
| -------------------- | -------------------------------------------- | -------- |
| Backend typecheck    | from `backend/`: `corepack yarn check-types` | exit 0   |
| Storefront typecheck | `npm run typecheck`                          | exit 0   |
| Storefront tests     | `npm test`                                   | all pass |
| Format               | `npm run format:check`                       | exit 0   |

Backend eslint is vacuous for `packages/api` (known); typecheck is the
gate there. This plan changes comments and doc text only — behavior-free
by construction; the greps in Done criteria are the real verification.

## Scope

**In scope** (comment/doc edits only — NO behavioral change):

- The 8 backend files listed above (comment text only)
- `src/app/leaderboard/page.tsx` (comment only)
- `src/lib/data/leaderboard.ts` (comment only)
- `src/lib/ttl-cache.ts` (header comment only)

**Out of scope**:

- Any Redis client, pub/sub, or cache-mechanism change — explicitly
  decided against above.
- `.do/*.yaml` — instance counts are correct as deployed.
- `src/lib/data/packs.ts`, `avatar-frames.ts`, `challenge.ts` — plan 117
  edits those files; to avoid merge friction, this plan's ladder lives in
  `ttl-cache.ts` only.
- The bust calls themselves (`bustPackCaches()` etc.) — they stay: they
  still serve same-instance admin reads correctly.

## Git workflow

- Branch: `advisor/116-cross-instance-cache-truth`
- Conventional commit, e.g. `docs(cache): tell the truth about two instances — bust is per-process, staleness is the ladder`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rewrite the four "IMMEDIATELY" bust comments

In files 6, 7, 8 and the invariant comment in file 5, replace the
immediacy claims with the two-instance truth. Target shape for
`bustPackCaches()` in `admin/packs/[slug]/route.ts` (adapt wording, keep
it ≤ the original length ballpark):

```ts
// Bust the 30s read caches IN THIS PROCESS (storefront list + detail, and
// the admin pack list). Since #473 the app runs 2 instances and these Maps
// are per-process: the instance that took the write serves the edit
// immediately, the other serves ≤30s stale until its window rolls. Bounded
// and display-only (purchase/spin paths re-check live state). If operators
// report edit-flapping in practice, the recorded upgrade is a Redis
// pub/sub bust on REDIS_URL — see src/lib/ttl-cache.ts's ladder note.
```

For `admin/packs/route.ts:34-35`, change "Every admin pack write busts it"
to "Every admin pack write busts it in the writing process; other
instances roll over within 30s (#473 runs 2)."

**Verify**:
`grep -rn "IMMEDIATELY" backend/packages/api/src/api/admin/packs/` → 0 matches.
`grep -rn "shows immediately" backend/packages/api/src/api/admin/packs/` → 0 matches.

### Step 2: Retire the tripped "Upgrade to Redis only if >1 instance" sentences

In files 1, 2, 3: the condition fired and the decision was made the other
way, so the sentence must not survive as a standing instruction. Replace
each with:

```
// >1 instance since #473: per-process is accepted — N instances = N
// computes per window and ≤TTL cross-instance skew, display-only either
// way. Decision + upgrade path recorded in plan 116.
```

**Verify**: `grep -rn "if we ever run" backend/packages/api/src/api/` → 0 matches.

### Step 3: Fix the storefront "per-request / live" claims

- `src/app/leaderboard/page.tsx:9-12`: replace "rendered per-request so it
  always reflects the current ledger" with e.g. "rendered per-request;
  standings and avatar frames are memoised (30s/60s per instance, see
  src/lib/ttl-cache.ts) — the challenge block is genuinely per-request."
- `src/lib/data/leaderboard.ts:55` "Live leaderboard for a period" →
  "Leaderboard for a period (rows memoised 30s per instance)".

**Verify**: `grep -n "always reflects the current ledger" src/app/leaderboard/page.tsx` → 0 matches.

### Step 4: Add the staleness ladder to `src/lib/ttl-cache.ts`'s header

Append to the existing header comment (after line 18):

```
// STALENESS LADDER (worst case per layer; per instance, 2 instances of
// each app since #473 — layers stack, they do not synchronize):
//   backend route Map        30s (packs list/detail, leaderboard; pulls 5s)
//   this storefront memo     30s (catalog, board) / 60s (avatar frames)
//   home route cache         15s (src/app/page.tsx revalidate)
//   getPackChase             60s (unstable_cache, no tags)
// ⇒ an admin pack edit can take ~60s to reach /slots, ~75s to reach /,
//   ~105s to reach a home chase card. Admin busts clear ONLY the writing
//   backend instance's Maps; the other instance rolls over on TTL.
```

**Verify**: `grep -c "STALENESS LADDER" src/lib/ttl-cache.ts` → 1.

### Step 5: Full gates

**Verify**: backend `corepack yarn check-types` → exit 0.
`npm run typecheck` → exit 0. `npm test` → all pass.
`npm run format:check` → exit 0 (run `npm run format` if needed — but note
the repo's prettier does NOT format backend/, so backend comment edits
must match the file's existing style by hand).
`git diff --stat` → only the 11 in-scope files, and every hunk is inside a
comment (reviewer check: `git diff` contains no non-comment line changes).

## Test plan

None — comment-only. The suite staying green (`npm test`, backend
typecheck) proves no code line moved.

## Done criteria

- [ ] The four greps in Steps 1–4 return the stated counts
- [ ] Backend `corepack yarn check-types` exits 0; `npm run typecheck` exits 0; `npm test` passes
- [ ] `git diff` shows comment/doc hunks only, in only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any excerpt mismatch (drift).
- You find an admin pack write path that does NOT call the bust trio
  (grep `clearPackListCache|clearPackDetailCache|clearAdminPackListCache`
  across `api/admin/packs/`) — that would be a real bug, not a comment
  fix; report it instead of patching silently.
- You feel the need to change any executable line. This plan has none.

## Maintenance notes

- The recorded upgrade path, if flapping ever hurts in practice: publish
  a `packs:bust` message from `bustPackCaches()` on the existing
  `REDIS_URL` ioredis client (see `api/utils/rate-limit.ts:454-476` for
  the client construction + error-listener pattern), with each API process
  subscribing at boot and clearing its local Maps on receipt. Degrades to
  today's TTL behavior when Redis is down. Note Medusa event-bus
  subscribers run on the WORKER component in this deployment
  (`.do/backend.app.yaml` documents this for the Telegram keys) — they
  cannot clear API-process Maps, so it must be a raw subscribe in the API
  process, not a Medusa subscriber.
- Plan 117 hardens the storefront `cached()` helper; if it lands first,
  re-anchor Step 4's insertion point on the current header text.
