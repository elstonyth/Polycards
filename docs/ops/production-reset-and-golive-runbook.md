# Production Reset & Go-Live Runbook

**Status:** prod (`polycards.gg`) is currently a **preview/demo** deployment. The plan is to
display everything first, then wipe the database entirely and officially launch from a fresh
start. This runbook covers what must be true before that reset, the reset itself, and how to
verify the result.

**Written:** 2026-07-19, after PRs #212/#213/#214 (Weekly Pulled Value Challenge + recorded
pull value) shipped to `master` (commit `7495ea4`). **Re-verified 2026-08-01** against
`master` `a993f34a` (plan 068) — §1.1 and the vendor self-registration bullet below were
struck as resolved; see each for the PR that closed it.

---

## 0. The one-line summary

A full DB wipe is **rebuildable for seeded data, but permanently destructive to user data** —
`yarn seed` rebuilds regions, sales channels, API keys, stock locations, shipping, tax regions,
store currencies, sellers, VIP levels, and the catalog. It does **not** bring back customer
accounts, credit ledgers, or pull history; the pre-wipe backup is the only undo.

It also mints a **new publishable key**, which the storefront inlines at **build** time from
**two** sources — the DO app spec *and* the `ARG` default in the root `Dockerfile`. Both must be
updated and the storefront **rebuilt** (not just restarted), or every store route 401s and the
site looks dead while the backend is perfectly healthy.

---

## 1. Blockers — must be resolved BEFORE the official start

These are not reset steps; they are gaps that make "officially started" untrue if skipped.

### 1.1 Weekly Challenge settlement — RESOLVED (#296)

Settled by PR #296: `backend/packages/api/src/jobs/settle-challenge-week.ts` is an hourly,
self-gating job that settles the most-recently-ended week — pays the top-10 the union of
every community-pool-unlocked stage's rank rewards and writes an immutable
`challenge_payout` row (its own header comment is the spec). Covered by
`backend/packages/api/src/modules/packs/__tests__/challenge-settle.integration.spec.ts` and
`challenge-settle.unit.spec.ts`. No action needed before launch.

### 1.2 Challenge stage thresholds are demo-sized

Prod currently renders `RM 1,533,517 / RM 100 — 100%`, i.e. every stage unlocked, "grand
finale week". The top stage threshold is RM 100. Set real thresholds in
**admin → Weekly Challenge → Milestone Stages** as part of go-live config.

Do **not** use `seed-challenge.ts` for this — it is an explicitly labelled demo seed
(RM 100k–1M ladder, featured cards picked arbitrarily from the catalog).

### 1.2b Vendor self-registration — RESOLVED (#173)

Was: `seller_registration:false` is UI-only; an anonymous `POST /vendor/sellers` created a
real seller (flagged MEDIUM in a prior audit). Closed by #173:
`backend/packages/api/src/api/middlewares.ts:120-139` hard-404s both registration
entrypoints (`/auth/member/emailpass/register` and `/vendor/sellers`), guarded by
`backend/packages/api/integration-tests/http/vendor-selfreg-block.spec.ts`. No action
needed before launch.

### 1.2c Payout approval threshold — must be SET deliberately, not left at default

A live GlobePay365 payout channel means real bank transfers can leave the merchant
account. `GLOBEPAY_WD_APPROVAL_ABOVE_RM` (default RM 1,000, unset) holds any withdrawal
above that figure in the admin `/withdrawals` queue for a human to approve or deny —
without a named operator watching that queue, a held withdrawal just sits, indefinitely,
looking to the customer like nothing happened.

Before arming withdrawals (`GLOBEPAY_WITHDRAWALS_ENABLED=true`):

1. Set `GLOBEPAY_WD_APPROVAL_ABOVE_RM` to a deliberately chosen figure, not silently left
   at the RM 1,000 default. Also confirm `GLOBEPAY_WD_DAILY_MAX_RM` (rolling-24h
   per-customer cap, default RM 50,000) and `PAYOUT_DESTINATION_COOLDOWN_HOURS` (default
   24) are the values intended — see `docs/payments/globepay365-setup.md`'s config table.
2. Confirm the admin `/withdrawals` queue's default view is `held`
   (`backend/apps/admin/src/routes/withdrawals/page.tsx` — `useState<GlobePayWithdrawalView>('held')`)
   so a held row is the first thing an operator sees, not something they have to filter
   into view.
3. **Name who watches the queue** and how often. Nothing in this codebase alerts on a
   held withdrawal — the queue shows it, but someone has to look.

### 1.3 Carried over from earlier sessions — VERIFY, do not assume

These were true when last checked but predate this runbook. Re-verify each before launch:

- **Google OAuth app still in Testing mode** — only whitelisted test users can sign in.
  Publishing the app is the last step for real customer Google login. (Not verifiable from
  code — this is a Google Cloud Console setting.)
- **Password-reset email is code-gated on both `RESEND_API_KEY` and `RESEND_FROM_EMAIL`**
  (`backend/packages/api/src/modules/resend/options.ts:19`, unchanged as of this
  re-verification) — without both set, the subscriber warns instead of sending, and
  customers cannot recover accounts. Both envs must be **app-level**, not job-level
  (subscribers run on the worker). Confirm the actual DO app spec before launch — this
  runbook cannot see prod env state.

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
| 1 | Back up first | manual DO snapshot — the only undo |
| 2 | Wipe: **drop and recreate the schema** | `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — do **not** hand-pick truncates (they miss tables and strand FK orphans) |
| 3 | **Prove the wipe** before seeding | post-wipe query below — every count must be 0 |
| 4 | Run migrations, then reseed core + catalog | `corepack yarn medusa db:migrate` → `SEED_DEMO=false corepack yarn seed` |
| 5 | Read the NEW publishable key | `corepack yarn medusa exec ./src/scripts/print-publishable-key.ts` |
| 6 | **Update `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` in BOTH places** | the storefront DO app spec **and** the `ARG` default at root `Dockerfile:58` |
| 7 | **Rebuild the storefront** (not restart — `NEXT_PUBLIC_*` is inlined at build) | DO deploy |
| 8 | Create the admin user | `medusa exec ./src/scripts/create-admin.ts` — `seed.ts` does NOT create one |
| 9 | Catalog art, if the reseeded catalog needs it | `replace-catalog-polycards.ts`, `bake-slab-images.ts` |
| 10 | Verify an FxRate row exists | else money display silently uses the `DEFAULT_USD_MYR = 4.7` fallback |
| 11 | Configure real challenge stages | admin → Weekly Challenge → Milestone Stages (§1.2) |

**Step 3 — post-wipe proof.** Run before seeding; a non-zero count means the wipe was partial
and step 4 would seed on top of survivors:

```sql
select
  (select count(*) from customer)           as customers,
  (select count(*) from pull)               as pulls,
  (select count(*) from credit_transaction) as credits;
```

**Step 6 — why both.** The key is inlined at build time. `Dockerfile:58` carries a hardcoded
`ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_…` default, so if App Platform does not pass the
build arg through, the **old** key is baked into the client bundle and the storefront 401s even
though the app spec looks correct. Update the app spec and the Dockerfile default together.

**Step 4 — `SEED_DEMO=false`** skips the 8 display-only demo collectors and the
`test@polycards.app` convenience login. Omit it and a live storefront launches with fake
collectors on public profiles and a known-password account.

**Note on step 8:** `resolveFxRate` falls back to 4.7 when no `FxRate` row exists. This does
not error — it silently prices everything at the fallback rate. `resolveFxRateInfo` exposes a
`stale` flag; confirm the real rate is live before taking money.

**Note on the recorded-value backfill:** not needed after a wipe. There is no history to pin,
and the open-pack/open-batch workflows stamp `recorded_value_usd` at draw time from the first
pull onward. (Confirmed 2026-07-19: on the current DB it reported `Stamped 0` because all 153
pulls were already stamped — `{total:153, stamped:153, unstamped:0}`.)

## 4. Post-reset verification

Fresh-DB behaviour is already known-good and should be re-confirmed:

- `/leaderboard` → standings only, with the challenge block absent (0 stages →
  `active:false`), **not** a crash or a blank page. `challengeSettings()` returns Monday 00:00 `Asia/Kuala_Lumpur`
  defaults with no settings row.
- `/leaderboard` → empty state, not fabricated rows.
- `/slots` → packs render (proves the publishable key rebuild in step 5 actually took).
- One real pack open end-to-end → a `pull` row appears **with** a non-null
  `recorded_value_usd`, and it shows on `/leaderboard`.
- After configuring stages: `/leaderboard` shows a sane ladder above the standings, not
  "every stage unlocked".

Read-only prod DB checks can run from the DO app console without touching the DB firewall —
node-pg needs TLS passed explicitly or it is rejected with `FATAL 28000 ... no encryption`:

```sh
node -e 'const{Client}=require("pg"),fs=require("fs");const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{ca:fs.readFileSync("/tmp/ca.crt","utf8")}});c.connect().then(()=>c.query("<SQL>")).then(r=>console.log(r.rows[0])).finally(()=>c.end())'
```

Fetch the CA once with `doctl databases get-ca <pg-cluster-uuid>`. Verifying against the cluster
CA is the only supported path here — do not disable certificate verification against production.

---

## 5. Known-good as of 2026-07-19 (`7495ea4`) — historical; §1 re-verified 2026-08-01 against `a993f34a`

- `master` = `7495ea4`; both DO apps ACTIVE on it.
- Weekly Challenge tracking/display half: shipped and verified live.
- Recorded pull value: shipped, migration applied, 153/153 pulls stamped.
