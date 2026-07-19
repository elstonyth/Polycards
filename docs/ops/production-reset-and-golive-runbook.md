# Production Reset & Go-Live Runbook

**Status:** prod (`polycards.gg`) is currently a **preview/demo** deployment. The plan is to
display everything first, then wipe the database entirely and officially launch from a fresh
start. This runbook covers what must be true before that reset, the reset itself, and how to
verify the result.

**Written:** 2026-07-19, after PRs #212/#213/#214 (Weekly Pulled Value Challenge + recorded
pull value) shipped to `master` (commit `7495ea4`).

---

## 0. The one-line summary

A full DB wipe is **recoverable** — `yarn seed` rebuilds regions, sales channels, API keys,
stock locations, shipping, tax regions, store currencies, sellers, VIP levels, and the
catalog. But it mints a **new publishable key**, and the storefront inlines that key at build
time, so the storefront must be **rebuilt** (not just restarted) or every store route 401s and
the site looks dead.

---

## 1. Blockers — must be resolved BEFORE the official start

These are not reset steps; they are gaps that make "officially started" untrue if skipped.

### 1.1 Weekly Challenge has no settlement engine (BLOCKING)

Verified in code 2026-07-19: `src/jobs/` contains only `mature-commissions.ts` and
`sync-market-prices.ts`, and **nothing** in `jobs/`, `workflows/`, or `subscribers/` references
the challenge. `service.ts` still comments "the reward settlement engine is inert."

What exists: draw-time value recording, the community pool aggregate, the pulled-value weekly
ranking (shared by `/task` and `/leaderboard`), admin config, and the storefront page.

What does **not** exist: at week end, nothing grants featured cards to ranks 1–3 or credits to
ranks 4–10, and nothing snapshots the closing standings. When the anchor moves, the board
recomputes for the new week and last week's top 10 disappears from every surface.

The underlying data survives (each `pull` row carries `rolled_at` and a pinned
`recorded_value_usd`), so standings stay *recomputable by hand* — but there is no automatic
payout and no history table.

Minimum to launch honestly, pick one:
- **Build it** — a job at reset that ranks the closing week, writes an immutable standings
  snapshot, and grants the cumulative unlocked rewards, with an admin review surface before it
  pays. Touches money → own PR, own tests.
- **Or** operate it manually week 1 and keep the page's reward copy future-tense (it already
  is), with a documented manual settlement procedure.

### 1.2 Challenge stage thresholds are demo-sized

Prod currently renders `RM 1,533,517 / RM 100 — 100%`, i.e. every stage unlocked, "grand
finale week". The top stage threshold is RM 100. Set real thresholds in
**admin → Weekly Challenge → Milestone Stages** as part of go-live config.

Do **not** use `seed-challenge.ts` for this — it is an explicitly labelled demo seed
(RM 100k–1M ladder, featured cards picked arbitrarily from the catalog).

### 1.3 Carried over from earlier sessions — VERIFY, do not assume

These were true when last checked but predate this runbook. Re-verify each before launch:

- **Google OAuth app still in Testing mode** — only whitelisted test users can sign in.
  Publishing the app is the last step for real customer Google login.
- **Password-reset email is env-gated OFF** — code complete, no API key set. Envs must be
  app-level (subscribers run on the worker). Without it, customers cannot recover accounts.
- **Vendor self-registration is open** — `seller_registration:false` is UI-only; an anonymous
  `POST /vendor/sellers` creates a real seller. Flagged MEDIUM in a prior audit. Close before
  a public launch.

---

## 2. Pre-reset

1. **Take a manual DB backup/snapshot** even though the data is throwaway — it is the only
   undo, and "throwaway" judgements have been wrong before.
2. **Media is not in the database.** Card art / slab composites live in Spaces
   (`pokenic-media`). A DB wipe does not delete objects, but it does delete the rows that
   reference them; the catalog re-import must repoint or re-bake.
3. **Decide what carries over.** A full wipe also destroys: admin users, customer accounts
   (incl. anyone who signed in with Google), publishable keys, sales channels, regions,
   sellers, and the credit ledger. All are reseedable; customers are not (they must
   re-register).

## 3. Reset sequence

Run from `backend/packages/api` unless noted.

| # | Step | Command / location |
|---|------|--------------------|
| 1 | Wipe the database | operator-chosen (drop/recreate schema, or a targeted truncate) |
| 2 | Reseed core + catalog | `corepack yarn seed` |
| 3 | Read the NEW publishable key | `corepack yarn medusa exec ./src/scripts/print-publishable-key.ts` |
| 4 | **Update `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`** in the storefront DO app spec | DO console / `doctl apps update` |
| 5 | **Rebuild the storefront** (not restart — `NEXT_PUBLIC_*` is inlined at build) | DO deploy |
| 6 | Recreate the admin user | `medusa exec ./src/scripts/create-admin.ts` |
| 7 | Catalog art, if the reseeded catalog needs it | `replace-catalog-polycards.ts`, `bake-slab-images.ts` |
| 8 | Verify an FxRate row exists | else money display silently uses the `DEFAULT_USD_MYR = 4.7` fallback |
| 9 | Configure real challenge stages | admin → Weekly Challenge → Milestone Stages (§1.2) |

**Note on step 8:** `resolveFxRate` falls back to 4.7 when no `FxRate` row exists. This does
not error — it silently prices everything at the fallback rate. `resolveFxRateInfo` exposes a
`stale` flag; confirm the real rate is live before taking money.

**Note on the recorded-value backfill:** not needed after a wipe. There is no history to pin,
and the open-pack/open-batch workflows stamp `recorded_value_usd` at draw time from the first
pull onward. (Confirmed 2026-07-19: on the current DB it reported `Stamped 0` because all 153
pulls were already stamped — `{total:153, stamped:153, unstamped:0}`.)

## 4. Post-reset verification

Fresh-DB behaviour is already known-good and should be re-confirmed:

- `/task` → the honest "launching soon" placeholder (0 stages → `active:false`), **not** a
  crash or a blank page. `challengeSettings()` returns Monday 00:00 `Asia/Kuala_Lumpur`
  defaults with no settings row.
- `/leaderboard` → empty state, not fabricated rows.
- `/slots` → packs render (proves the publishable key rebuild in step 5 actually took).
- One real pack open end-to-end → a `pull` row appears **with** a non-null
  `recorded_value_usd`, and it shows on `/task` + `/leaderboard`.
- After configuring stages: `/task` shows a sane ladder, not "every stage unlocked".

Read-only prod DB checks can run from the DO app console without touching the DB firewall —
node-pg needs TLS passed explicitly or it is rejected with `FATAL 28000 ... no encryption`:

```
node -e 'const{Client}=require("pg"),fs=require("fs");const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{ca:fs.readFileSync("/tmp/ca.crt","utf8")}});c.connect().then(()=>c.query("<SQL>")).then(r=>console.log(r.rows[0])).finally(()=>c.end())'
```

Fetch the CA once with `doctl databases get-ca <pg-cluster-uuid>`. `ssl:{rejectUnauthorized:false}`
also connects but disables certificate verification — acceptable only for a throwaway read.

---

## 5. Known-good as of 2026-07-19

- `master` = `7495ea4`; both DO apps ACTIVE on it.
- Weekly Challenge tracking/display half: shipped and verified live.
- Recorded pull value: shipped, migration applied, 153/153 pulls stamped.
