# Backend Feature Tasks — one session per task

> Written 2026-06-11 after the security/cleanup wave (commits `a34992f..1b48e24`:
> stub routes deleted, integer-cents buyback math, duplicate-registration 409,
> auth + vault/credits rate limits, bearer-only customer auth, secrets rotated).
> Each task below is sized for ONE session and is self-contained — start a fresh
> session, point it at this file, run the task, commit, check the box.
>
> **Product decisions already made (do not re-litigate):**
> - Pack opens COST CREDITS once the payment seam is wired — no more free opens
>   for logged-in customers. Guests get a DEMO SPIN only (nothing recorded,
>   nothing claimable).
> - No provably-fair RNG — frontend shows static odds; the server's weighted
>   roll stays as-is.
> - Mock (non-real) payment gateway first; the real gateway swaps in later
>   behind the same top-up route.
> - Single-vendor model: the house seller IS the admin. No vendor onboarding.
> - Defer: Google/Discord social login (buttons stay placeholders). When it
>   DOES land: cover its credential/callback auth routes with the auth rate
>   limiter — the current matcher only covers `/auth/*/emailpass(/*)`.
>
> **Environment ground rules** (same as GAP_CLOSURE_KICKOFF.md): backend :9000
> (PM2 `pokenic-backend`, dev mode), storefront verify on :4000 against a REBUILT
> prod build (`npm run build` + `pm2 restart pokenic-store`), never `next dev`.
> Backend gate: `corepack yarn build` in `backend/packages/api` + unit tests
> (`TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest`
> from Git Bash). Integration: `TEST_TYPE=integration:http …` (needs
> `pokenic-postgres` + `pokenic-redis` containers). Commit per task on `master`.

---

## ☐ Task A1 — Mock top-up: buy site credit through a fake gateway

**Goal:** a logged-in customer can add credit to their balance through a
fake-but-realistic payment flow. Real money never moves; the credit ledger is
the source of truth.

**Context:** the credit ledger already exists and is battle-tested —
`CreditTransaction` model (append-only, balance = Σ) in
`backend/packages/api/src/modules/packs/models/credit-transaction.ts`, summed by
`modules/packs/credit-balance.ts`, exposed at `GET /store/credits`. Buyback
writes credit rows in `workflows/steps/buyback-pull.ts` — copy its patterns.
NOTE: `CreditTransaction.pull_id` is UNIQUE and non-null today — top-up rows
need a migration (nullable `pull_id` or a discriminated `reason`/`reference`
column pair; `reason` exists already — extend its values with `"topup"`).

**Build (backend):**
- `POST /store/credits/topup` (authed customer, bearer — register matcher in
  `src/api/middlewares.ts` AFTER `authenticate("customer", ["bearer"])`, reuse
  the vault-buyback rate limiter construction). Body: `{ amount }` (validate:
  finite, > 0, ≤ a sane cap like 10_000, 2dp max).
- `topUpCreditsWorkflow` + step: writes a `CreditTransaction`
  (`reason: "topup"`, amount in USD decimals — integer-cents validation like
  `buybackAmount` in `modules/packs/buyback-rate.ts`).
- A `MockPaymentProvider` boundary (plain module function is fine): takes
  `{amount, customer_id}`, returns `{ok, reference}` — ALWAYS succeeds, but
  keep the call seam so the real gateway replaces exactly this function. A
  fake decline path (e.g. amount ending in .13 declines) makes the UI error
  path testable.

**Build (storefront):** "Add credits" UI on the `/(account)` credits/vault
surface (balance display exists — `src/app/(account)` + `lib/data` credits
fetch). Fake card form (number/expiry/cvc, client-side only, clearly marked
demo), posts the amount via the existing server-action pattern
(`src/lib/data/customer.ts` holds the JWT cookie pattern).

**Verify:** unit tests for validation; integration test: top-up → `GET
/store/credits` reflects new balance; decline path returns friendly error.
Storefront: top up on :4000, balance updates.

---

## ☐ Task A2 — Charge pack opens from the credit balance (PAYMENT SEAM)

**Goal:** opening a pack deducts its price from the customer's credit balance;
insufficient credit blocks the open with a friendly error. Free opens end.
**Depends on A1** (customers need a way to get credit).

**Context:** the seam is marked in
`backend/packages/api/src/workflows/open-pack.ts` (`── PAYMENT SEAM ──`,
~line 32) — a charge step slots BEFORE `recordPull` so a failed charge rolls
everything back and never leaves an unpaid Pull. Pack price lives on the Pack
row (`modules/packs/models/pack.ts`, USD decimal). The credit ledger is from A1.

**Build:**
- `chargePackOpenStep`: reads the pack price, computes balance
  (`creditBalance()`), throws `MedusaError` NOT_ALLOWED "Not enough credits"
  when balance < price, else writes a NEGATIVE `CreditTransaction`
  (`reason: "pack_open"`, amount = -price). Compensation: delete the charge
  row (mirror `buyback-pull.ts`'s credit-row-first + manual-undo pattern).
  RACE NOTE: balance check + write is read-then-write — two concurrent opens
  can overspend. Acceptable first pass (mirror the stock-counter decision) but
  note it; a DB-level guard (SELECT ... FOR UPDATE via raw SQL, or a CHECK on
  running balance) can land with the real gateway.
- Insert into `openPackWorkflow` composition between `rollPackStep` and
  `recordPullStep` (composition is pure — derived values through
  `transform()`, no literals/conditionals in the body).
- Open route 402 mapping: NOT_ALLOWED already maps to 400 — keep 400 + typed
  body, storefront `friendlyError` maps it to "not enough credits" copy.
- Storefront: pack detail page shows price + balance; failed open surfaces the
  message + a link to top up. The reveal overlay's sell-back math is untouched.
- Demo collectors / seeded pulls are historical — do NOT retro-charge.

**Verify:** integration test in `integration-tests/http/` (fixtures pattern in
`vault-buyback.spec.ts` — single-card pool makes rolls deterministic): open
with sufficient credit debits exactly price; insufficient → 4xx, NO Pull row,
NO stock decrement; buyback after a paid open still credits correctly.
Storefront: full loop on :4000 — top up → open → balance drops → sell back →
balance rises.

---

## ☐ Task B — Real public profiles: `GET /store/profiles/:handle`

**Goal:** `/profile/[user]` shows real data for any customer, safe-public
subset only. Replaces the deterministic mock pool.

**Context:** decision history in `docs/note.md` (2026-06-08 entry). Storefront
pages: `src/app/profile/[user]/page.tsx` + `ProfileClient.tsx` (mock pool).
Medusa has no public customer endpoint — this is a custom route. Customer
"handle": there is none today — derive one (e.g. slug of display name or the
email local part is PII-risky; safest: customer id-based handle or a stored
`metadata.handle`). Decide in-session; simplest durable choice: store a
generated unique handle in customer `metadata` at registration/first-profile
view, look up by that.

**Build:**
- `GET /store/profiles/:handle` (PUBLIC route — publishable-key scoped like
  `/store/packs`; no auth): returns display name, avatar (if any), join date,
  public pull stats (counts by rarity from `Pull` rows joined to PackOdds —
  the same join as `/store/leaderboard`), recent public pulls. NEVER email,
  addresses, credit balance, or vault contents.
- Rate-limit it with `createStoreReadRateLimit()`-style limiter (public → keys
  on IP automatically).
- Storefront: `ProfileClient` fetches real data; keep the mock pool ONLY as
  the loading/empty skeleton. The logged-in user's own profile link should use
  their real handle.

**Verify:** integration test: profile of a seeded demo collector returns stats,
unknown handle → 404, response contains no PII fields. Storefront on :4000:
visit a demo collector's profile.

---

## ☐ Task C — Guest demo spin (frontend) + auth-gating sweep

**Goal:** logged-out visitors can try the pack-open reveal as a clearly-labeled
DEMO — nothing recorded, nothing claimable, no stock/odds touched. Logged-in
customers keep the real flow. (Decision: guests get demo spin ONLY; real opens,
marketplace purchase, top-up, vault all stay login-gated.)

**Context:** the reveal overlay is `PackOpenOverlay` (storefront; found via the
sell-countdown work — `src/components`/pack detail tree, plus
`src/lib/sell-countdown.ts`). The open action lives in the pack detail client
(`openPack` server action returns pullId + marketValue). `/store/packs/:slug`
(public) already returns the pack's odds/pool — enough to fake a draw
client-side.

**Build:**
- Pack detail for a logged-out user: "Try a demo spin" button instead of (or
  beside) the real open CTA. Demo mode runs the SAME overlay animation with a
  client-side weighted sample over the public odds (`Math.random` is fine — it
  is theater), watermarks the result "DEMO", and replaces keep/sell buttons
  with a "Sign up to keep what you pull" CTA → auth page.
- NO new backend route, NO Pull row, NO credit/stock effects. The real open
  action keeps requiring auth (it already 401s — middlewares.ts).
- Sweep the gated surfaces while there: vault/credits pages already redirect
  anonymous users (`/(account)` gating); confirm marketplace buy + top-up CTAs
  route to login when anonymous.

**Verify:** Playwright script (`scripts/*.mjs` pattern) on :4000: anonymous →
demo spin plays, result labeled, no network POST to /store/packs/*/open fired
(assert via page network log); logged-in → real flow unchanged.

---

## ☐ Task D — Forgot-password flow (log-mail provider now, real mail later)

**Goal:** "Forgot password?" works end-to-end. Email delivery is a dev-mode
console/log provider for now; swapping in Resend/SendGrid later is config.

**Context:** stub noted in `docs/note.md`. Medusa v2 emailpass provider ships
reset natively: `POST /auth/customer/emailpass/reset-password` (emits
`auth.password_reset` with `{entity_id (email), token}`) →
`POST /auth/customer/emailpass/update` with the token + new password. The new
auth rate limiter already covers BOTH (the `/auth/*/emailpass/*` matcher).
Medusa docs: load the medusa-dev skill refs (`authentication.md`,
`subscribers-and-events.md`) before building.

**Build (backend):** subscriber `src/subscribers/password-reset.ts` on
`auth.password_reset`: builds
`${STOREFRONT_URL}/reset-password?token=…&email=…` and — until a real
notification provider lands — logs it at WARN level (greppable:
`pm2 logs pokenic-backend`). Add `STOREFRONT_URL` to `.env.template`.

**Build (storefront):** "Forgot password?" in `AuthForm` → email-entry form →
posts reset-password (always "check your email" response — no account
enumeration). `/reset-password` page reads token+email from query, posts
update, redirects to login on success.

**Verify:** integration test: reset-password 201s for known AND unknown email
(no enumeration); update with valid token changes the password (old fails, new
works); reused/garbage token → 4xx. Manual loop on :4000 with the logged link.

---

## ☐ Task E — Catalog gap: missing live packs (needs live re-capture)

**Goal:** parity with live `/claw`: pokemon **Sealed $100** + **Base Set $500**
out-of-stock tiers, and the two missing baseball packs
(`platinum-baseball-pack`, `mythic-baseball-pack`).

**Context:** deferred from the 2026-06-11 cleanup wave because the 2026-06-07
captures (`docs/research/gap/claw-extract.json`) predate these packs — titles/
prices/icons must be MEASURED from live, not guessed (pixel-perfect rule).
Punchlist refs: `docs/research/AUDIT_PUNCHLIST.md` (~line 138) +
`docs/research/GAP_CLOSURE_KICKOFF.md` Task 3c. Out-of-stock pattern to copy:
`pokemon-trainer` (`inStock: false` in `src/app/claw/packs-data.ts` ~line 68;
seed `in_stock: false` in `backend/packages/api/src/scripts/seed.ts` ~line 459).

**Build:** capture live /claw (Playwright script, live scrolls inside
`main.overflow-y-auto`); download the 4 icon webps into `public/images/claw/`
(check for phygitals watermarks — rebrand scripts `scripts/rebrand_*.mjs` if
needed); add entries to `packs-data.ts` + `PACK_SEED_GROUPS` in seed.ts; reseed
gotcha: seed skips packs that already have odds — new out-of-stock packs may
stay draft/odds-less (fine, matches live "out of stock"). Bump `CLAW_REV` in
`src/app/claw/packs-data.ts` if any claw pixel changed.

**Verify:** `npm run check`; capture clone vs live side-by-side to
`docs/research/`; record disposition in AUDIT_PUNCHLIST.md.

---

## ☐ Task F — PriceCharting token (5 minutes, when purchased)

Paste the token into `backend/packages/api/.env` as
`PRICECHARTING_API_TOKEN=…` → `pm2 restart pokenic-backend` → in admin :7000
Gacha Cards → "Add from inventory" → FMV lookup returns prices (today it shows
the friendly 503 fallback). No code.

---

## Suggested order

A1 → A2 (economy loop closes) → B → C → D. E independent (visual session).
F whenever the subscription is bought.
