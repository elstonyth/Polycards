# BUILD_PLAN.md Route-Treatment Validation Report

**Scope:** all 41 storefront routes in `src/app/**/page.tsx`, validated against the bucket + wiring treatment in `docs/BUILD_PLAN.md` (wiring map L215–228; coverage boundary L233–249).
**Method:** per-route code read + render (manifest/screenshot) corroboration; every mismatch run through an adversarial 3-lens panel (code / render / docs); plus a route-completeness reconciliation and a Medusa-v2 SDK-correctness cross-check on the WIRED rows.
**Report only — BUILD_PLAN.md was not edited.**

Verified independently for this report: 41 `page.tsx` files exist; `manifest.json` + all 41 route screenshots present in `docs/research/route-qa/`; plan L217 still reads `productCategory.list()` (zero `sdk.store.category` occurrences in the plan); zero `prizes|PRIZE` occurrences in the plan (leaderboard Prizes-tab gap confirmed); /social, /card, /pack-party code spot-checked and the panel calls hold.

---

## 1. Per-route table

Render column legend: **✓** = render (screenshot + manifest) corroborates the route's *nature* (static-vs-interactive, money/coin UI, and the WIRED "Today" half). Render does **not** adjudicate wiring-method correctness, so a wiring-only gap never shows as ✗ here. All 41 `renderCheck.corroborates = true`.

| # | Route | Plan bucket | Actual (1–3 words) | Render | Verdict | One-line note |
|---|---|---|---|---|---|---|
| 1 | `/` | WIRED core | static display, wired | ✓ | MATCH | Home sections (OpenPacks/RecentPulls/Leaderboard) hardcoded; plan actively wires them. |
| 2 | `/marketplace` | WIRED core | interactive grid | ✓ | **CONFIRMED** | Bucket/Today correct; SDK token `productCategory.list()` is Admin-only — must be `sdk.store.category.list()`. |
| 3 | `/claw` | WIRED core | commerce catalog | ✓ | MATCH | Tab filter + quantity steppers; Open → navigate; list wiring correct. |
| 4 | `/claw/[slug]` | WIRED core | gacha configurator | ✓ | **CONFIRMED** | Spice odds-tier selector is a real per-open control the Open wiring (`quantity` only) omits. |
| 5 | `/card/[id]` | WIRED core | card detail | ✓ | **CONFIRMED** | 3 action buttons (Buy/Make offer/Sell); wiring row covers only "buy → cart/checkout". |
| 6 | `/profile/[user]` | WIRED core | read-only profile | ✓ | MATCH | Tab view over mock; bucket correct. (Medusa `+ customer` seam is imprecise — see §5.) |
| 7 | `/login` | WIRED core | demo auth form | ✓ | **CONFIRMED** | Login-only "Forgot password?" button uncovered by the wiring row. |
| 8 | `/signup` | WIRED core | demo auth form | ✓ | MATCH | Fakes submit; `sdk.auth.*` seam named. (Register two-step caveat — see §5.) |
| 9 | `/orders` | WIRED core | static table | ✓ | MATCH | MOCK_CARDS rows → `sdk.store.order.list()` correct. |
| 10 | `/settings` | WIRED core | static form | ✓ | MATCH | Inline profile fields → `sdk.store.customer.update()` correct. |
| 11 | `/leaderboard` | WIRED core | interactive table | ✓ | **CONFIRMED** | 3rd "Prizes" tab + "1-9 of 999" pager omitted; endpoint lacks offset/limit + Prizes. |
| 12 | `/roulette` | DEFERRED | gacha mechanic | ✓ | MATCH | Mock spin over MOCK_CARDS; "arrives with the backend". |
| 13 | `/lucky-draw` | DEFERRED | gacha mechanic | ✓ | MATCH | Filter tabs over sliced MOCK_CARDS. |
| 14 | `/repacks` | DEFERRED | gacha mechanic | ✓ | MATCH | Category filter over inline PACKS. |
| 15 | `/free` | DEFERRED | marketing static | ✓ | **CONFIRMED** | Pure static signup funnel, 0 interactivity — belongs in STATIC, not DEFERRED. |
| 16 | `/store` | DEFERRED | gacha mechanic | ✓ | MATCH | Static product grid; Buy → `/claw` link. |
| 17 | `/clawmaker` | DEFERRED | gacha mechanic | ✓ | MATCH | Pack-builder; "odds tuning & publishing connect to the backend." |
| 18 | `/activity` | DEFERRED | account feature | ✓ | MATCH | Static mock transaction feed. |
| 19 | `/fairness` | DEFERRED | gacha mechanic | ✓ | MATCH | Static commit-reveal proofs. |
| 20 | `/series` | DEFERRED | gacha mechanic | ✓ | MATCH | Static series tiles. |
| 21 | `/pokemon/generation/[gen]` | DEFERRED | gacha mechanic | ✓ | MATCH | Pokédex search/lang tabs over local mock + public sprite CDN. |
| 22 | `/messages` | DEFERRED | account feature | ✓ | MATCH | Static conversation list + DemoNote. |
| 23 | `/achievements` | DEFERRED | account feature | ✓ | MATCH | Static badge grid + DemoNote. |
| 24 | `/submitcards` | DEFERRED | account feature | ✓ | MATCH | Inert submission form (server component). |
| 25 | `/earnings` | EXCLUDED | financial-crypto | ✓ | MATCH | USD balances + "Withdraw to bank" (inert). Money rule → EXCLUDED. |
| 26 | `/referrals` | EXCLUDED | financial-crypto | ✓ | MATCH | Referral-earnings stat + invite URL. |
| 27 | `/vouchers` | EXCLUDED | financial-crypto | ✓ | MATCH | Static voucher cards. |
| 28 | `/bank-withdrawal` | EXCLUDED | financial-crypto | ✓ | MATCH | Balance + withdrawal form (inert). |
| 29 | `/borrow-lend` | EXCLUDED | financial-crypto | ✓ | MATCH | Collateral/lend-yield stats. |
| 30 | `/pokecoin` | EXCLUDED | financial-crypto | ✓ | MATCH | PKC coin balance + Redeem (inert). |
| 31 | `/nbacoin` | EXCLUDED | financial-crypto | ✓ | MATCH | NBC coin balance + Redeem (inert). |
| 32 | `/accelerate-claim` | EXCLUDED | financial-crypto | ✓ | MATCH | $9.99 fee buttons (inert). |
| 33 | `/airdrop` | EXCLUDED | marketing static | ✓ | MATCH | Static teaser; "airdrop" content → EXCLUDED list. |
| 34 | `/launchpad/[brand]` | EXCLUDED | financial-crypto | ✓ | MATCH | On-chain/minted tiers + FAQ accordion. |
| 35 | `/about` | STATIC | marketing static | ✓ | MATCH | Pure marketing; "card or crypto" is a payment-method descriptor. |
| 36 | `/contact` | STATIC | marketing static | ✓ | MATCH | Mailto + vault status + FAQ links. |
| 37 | `/how-it-works` | STATIC | marketing static | ✓ | MATCH | Marketing page; FAQ accordion + buyback info pill only. |
| 38 | `/pack-party` | STATIC | gacha mechanic | ✓ | **CONFIRMED** | Multiplayer group-open gacha (entry/chase/avg, Join/Create) — belongs in DEFERRED. |
| 39 | `/social` | STATIC | account feature | ✓ | **DISPUTED** | Community directory, but NO backend seam (tab is CSS-only; no fetch) — STATIC holds. |
| 40 | `/merchants` | STATIC | marketing static | ✓ | MATCH | Curated merchant grid, local CSS filter only. |
| 41 | `/30th` | STATIC | marketing static | ✓ | MATCH | Static celebration page, link CTAs. |

---

## 2. CONFIRMED MISMATCHES (7)

Each survived the adversarial panel (no winning refutation). Where a lens dissented, it is shown explicitly — two of these are 2-1, not 3-0.

### 2.1 `/marketplace` — wiring-sdk-file — confidence: normal — panel 2-1 (code ✓, docs ✓, **render ✗ REFUTED**)
- **code (upheld):** repo-wide grep for `sdk.store.category|productCategory` = 0 matches; `MarketplaceClient.tsx:60-204/207-221/224-237` are inline `CARDS`/`CATEGORIES`/`FILTER_GROUPS` with real `useState` (:419-421). The plan's `sdk.store.*` mandate (L211) can't resolve `productCategory.list()` under store.
- **docs (upheld):** Context7 Medusa v2 — storefront category listing is `sdk.store.category.list()` (returns `{product_categories}`); `ProductCategory.list()` is documented only under the **Admin** SDK (`sdk.admin.productCategory`). No `sdk.store.productCategory` accessor exists.
- **render (REFUTED — dissent):** `marketplace.png` shows a fully-populated commerce grid + 13-item category strip + filter rail; an SDK-accessor name on a future Phase-2 "Rewire to" line is invisible to the render lens. *This dissent does not overturn the mismatch — render simply cannot see wiring-method correctness; code+docs carry it.*
- **Evidence:** `BUILD_PLAN.md:217`; `MarketplaceClient.tsx:60-204,207-221,224-237,419-421`; `marketplace.png`.
- **Confirmed wrong:** the SDK method name only. Bucket (WIRED/core-commerce) and "Today" (16 cards / 13 categories / filter groups) are accurate.
- **Exact plan edit (L217):** change `productCategory.list()` → `sdk.store.category.list()` (hits `GET /store/product-categories`, returns `{ product_categories }`). `sdk.store.product.list()` in the same row is correct — leave it.

### 2.2 `/claw/[slug]` — uncovered-interaction — confidence: normal — panel 2-1 (code ✓, render ✓, **docs ✗ REFUTED**)
- **code (upheld):** spice is a real wired control — `useState` (:96), `setSpice` (:323), "Select Spice Level" 3-tier swaps the `LIVE_ODDS` table (:347) and EV via `SPICE_MULT` (:105) — structurally co-equal to `qty`. Yet `spin()` (:120-135) lands on a constant `strip[WIN_INDEX]` and the plan carries only `quantity` into `POST /open` (L220, L271), silent on spice.
- **render (upheld):** `claw_slug.png` shows a prominent "SELECT SPICE LEVEL" (Mild/Medium/Hot) segmented control directly above "Open Pack" that visibly drives "Expected Value $1,020 per pack" — a user-facing per-open odds-tier the Open→POST wiring omits.
- **docs (REFUTED — dissent):** per Medusa v2 the wiring is idiomatic — `sdk.client.fetch` for custom `/store/*`, JWT-authed store routes, POST through a workflow with `validateAndTransformBody`. The spice body field is application design that docs neither require nor forbid (`{quantity}` vs `{quantity,spice}` equally idiomatic). *This dissent narrows the defect to plan completeness, not a bad/deprecated method — it does not clear the gap; code+render carry it.*
- **Evidence:** `PackDetailClient.tsx:42-67,94-100,105,120-135,311-337,347`; `BUILD_PLAN.md:220,271`; `claw_slug.png`.
- **Confirmed wrong:** the wiring row silently omits this interactive gacha control. Bucket and "Today" are correct.
- **Exact plan edit (L220 + Phase 5 L271):** extend Open to carry the selected tier, e.g. `Open → POST /store/packs/:id/open (customer JWT, quantity, spice/odds-tier) → weighted roll uses the chosen tier's PackOdds`. **Or**, if spice stays cosmetic, add one sentence stating the spice selector remains a display-only mock (not sent to the backend).

### 2.3 `/card/[id]` — uncovered-interaction — confidence: normal — panel 3-0 (code ✓, render ✓, docs ✓)
- **code (upheld):** three real onClick buttons — Buy now (:88), Make offer (:91), Sell/88%-buyback (:82,:94, "Buyback {usd(card.fmv*0.88)}"); distinct note strings ("Checkout"/"Offers"/"Instant sell-back") prove separate interactions. The sibling pack row (L220) already wires an analogous buyback to `POST /store/pulls/:id/sell-back`.
- **render (upheld):** `card_id.png` shows three equally-prominent buttons (Buy now / Make offer / Sell) + a visible "Buyback $35.20" line; manifest `buttons:3` confirms all are real.
- **docs (upheld):** the row's own method (`sdk.store.product.retrieve()`) and "buy → cart" (`sdk.store.cart.createLineItem`) are correct; the gap is uncovered interactions, and the buyback is idiomatically wireable (per the sibling row).
- **Evidence:** `CardDetailClient.tsx:14,82,88-89,91-93,94-96`; `BUILD_PLAN.md:220,221`; `card_id.png`.
- **Confirmed wrong:** wiring row (L221) addresses only "buy → cart/checkout"; "Make offer" and "Sell" are omitted. Bucket, "Today", and `product.retrieve()` are correct.
- **Exact plan edit (L221):** extend the "Rewire to" cell, e.g. `…; buy → cart/checkout; Make offer → offer stub/endpoint; Sell → instant buyback (sell-back workflow, ~88% FMV)`. For consistency with L220, wire Sell to the same sell-back workflow.

### 2.4 `/login` — uncovered-interaction — confidence: normal — panel 3-0 (code ✓, render ✓, docs ✓)
- **code (upheld):** `AuthForm.tsx:60-64` renders (when `!isSignup`) a login-only "Forgot password?" button (`type=button`, own onClick → "Password reset goes live with the backend."), yet `BUILD_PLAN.md:225` names only submit (`sdk.auth.register/login`) + social.
- **render (upheld):** `login.png` shows a distinct 4th control "Forgot password?" in the email/password section; manifest `buttons:4` (Google + Discord + Forgot + Log in).
- **docs (upheld):** the omitted button maps to a real v2 flow — `sdk.auth.resetPassword("customer","emailpass",{identifier})` then `sdk.auth.updateProvider(...,token)` (`POST /auth/{actor}/{provider}/update`). No deferred/excluded/static bucket covers it.
- **Evidence:** `AuthForm.tsx:12-21,34-45,50,54-55,60-64,66-74`; `BUILD_PLAN.md:225`; `login.png`.
- **Confirmed wrong:** the omitted "Forgot password?" interaction. Bucket, "Today", and the SDK methods are otherwise correct.
- **Exact plan edit (L225):** extend the row's "Rewire to" cell to either wire it (`sdk.auth.resetPassword` / generate-reset-token) or fold it into the deferred set as "(social + password reset = later)".

### 2.5 `/leaderboard` — uncovered-interaction — confidence: normal — panel 3-0 (code ✓, render ✓, docs ✓)
- **code (upheld):** `page.tsx:29` has THREE tabs ("Weekly","All Time","Prizes") but the plan enumerates only `period=weekly|alltime`; the "Prizes" tab (`:310-311`) renders a separate hardcoded `PRIZE_TIERS` array (`:32-38`) the row never names; `:202`/`:197-237` shows "1-9 of 999" with a pager a paramless `GET /store/leaderboard` cannot serve. (Independently verified: grep of the plan for `prizes|PRIZE` = 0 hits; `offset|limit|pagination` absent from the row.)
- **render (upheld):** `leaderboard.png` shows the third "Prizes" tab and a "1-9 of 999" prev/1/2/3/next pager beneath the table.
- **docs (upheld):** Context7 Medusa v2 — custom list routes return `{items, count, limit, offset}` and pass pagination via `sdk.client.fetch(path, { query: { limit, offset } })`; a 999-row leaderboard requires offset/limit + a count, which the endpoint string omits.
- **Evidence:** `leaderboard/page.tsx:23-27,29,32-38,197-237,240,310-311`; `LeaderboardSection.tsx:17-98`; `BUILD_PLAN.md:224`; `leaderboard.png`.
- **Confirmed wrong:** two real interactions omitted (Prizes tab + pagination). Bucket and "Today" (hardcoded entries/podium) are correct.
- **Exact plan edit (L224 + Phase 7 L277-278):** (1) note the **Prizes** tab stays a static `PRIZE_TIERS` panel, explicitly out of the `weekly|alltime` endpoint; (2) add **pagination** params + total count, e.g. `GET /store/leaderboard?period=weekly|alltime&offset=&limit=`. Optionally note the Settings gear (`page.tsx:268`) stays cosmetic.

### 2.6 `/free` — bucket — confidence: normal — panel 3-0 (code ✓, render ✓, docs ✓)
- **code (upheld):** `free/page.tsx` is a pure server component (no `'use client'`), no `useState`/onClick/form, no `@/lib/mock` or `usd`; `PACKS` (L11-17) is decorative hero art, `STEPS` (L19-23) marketing copy, sole action `<Link href="/signup">` (L62-63). Unlike genuine DEFERRED siblings whose feature lives in-code (e.g. roulette spin + "arrives with the backend"), `/free`'s source is identical to STATIC `/how-it-works`. "$500" (L22) is a hardcoded `<p>` + decorative Banknote icon, not a balance/payout.
- **render (upheld):** `free.png` shows a static signup-funnel hero + pack fan + 3 inert step cards + one CTA link; manifest `interactiveCount:0, buttons:0, demoHits:[], moneyHits:[], links:1` carries neither the gacha signature nor the account money-sidebar signature — it pattern-matches the STATIC cluster (/about, /contact, /30th).
- **docs (upheld):** the plan's DEFERRED definition requires a route that "reuses an existing pattern (a workflow + a custom route, or a read query)" (L240-242), but `/free` has zero data need — matching the STATIC definition "static content, no backend" (L247-249). The "$500 / sell back" is decorative; the plan already wires "sell back at 90%" as core buyback (L220,273), so neither the money/EXCLUDED rule nor DEFERRED applies.
- **Evidence:** `free/page.tsx:1,11-17,19-23,62-67`; `free.png`; `BUILD_PLAN.md:239-242,247-249`.
- **Confirmed wrong:** bucket assignment (currently DEFERRED).
- **Exact plan edit:** move `/free` from the **DEFERRED list (L239-240)** to the **STATIC list (L247)**.

### 2.7 `/pack-party` — bucket — confidence: normal — panel 3-0 (code ✓, render ✓, docs ✓)
- **code (upheld):** `pack-party/page.tsx:1` is `'use client'`; real `useState<Tab>('Active')` (:241) with `onClick={() => setTab(t)}` (:301); inert transactional CTAs `Join Party` (:224/:227) and `Create Party` (:284/:287) (`type=button`, no onClick = backend-wiring TODOs); real gacha logic `greatDeal = party.entry < party.avg` (:106) over inline `ACTIVE_PARTIES`/`COMPLETED_PARTIES` (:49-68). Same join/open mechanic class the plan wires for `/claw`, not content like its bucket-mates /about & /how-it-works.
- **render (upheld):** `pack-party.png` shows a live Active/Completed toggle, a paginated ("Page 1 of 4") grid of party cards with per-record entry/chase/avg USD ($54/$103/$56), a "great deal" badge, seat-fill progress bar, "Join Party"/"Create Party" CTAs, and copy "Multiple players enter, one pack is opened, cards allocated at random" — a multiplayer gacha feature, not marketing prose.
- **docs (upheld):** the plan's own L248 entry calls /pack-party a "live group opening — reassess after the core, per Risks" — verbatim the DEFERRED definition — which contradicts its L228 "static marketing" label. The entry-fee → one-pack-opened → random-allocation mechanic is precisely the open-pack workflow + a join route + a `party.filled` Socket.io event the plan already builds.
- **Evidence:** `pack-party/page.tsx:1,9,49-68,106,214-229,241,283-289,301`; `pack-party.png`; `BUILD_PLAN.md:228,248`.
- **Confirmed wrong:** bucket assignment (currently STATIC; the plan's own L248 hedge already flags it).
- **Exact plan edit:** remove `/pack-party` from the **STATIC list (L247-248)**, add to the **DEFERRED list (L239)**, and add a DEFERRED wiring row: `| /pack-party | inline ACTIVE_PARTIES / COMPLETED_PARTIES arrays | POST /store/pack-parties (join); GET /store/pack-parties?status=active|completed; Socket.io party.filled event |`.

---

## 3. DISPUTED (1) — panel majority REFUTED, no plan edit needed

### `/social` — proposed mismatch: bucket STATIC→DEFERRED — **REFUTED 2-1** (code REFUTED, docs REFUTED, render upheld)
- **Winning refutation (code lens):** the plan's load-bearing "no backend" claim holds. `page.tsx` has zero fetch/await/useEffect/sdk/API calls and no money terms; its only data source is the static local `MOCK_USERS` array (`users.ts:31`). The reviewer's central "useState-driven tab filtering" claim is **factually wrong** — `tab` (`page.tsx:14`) is used solely for the active-tab CSS highlight (`:30`), and `MOCK_USERS.map` (`:40`) never filters by it; Sort (:33) and Trade (:56) have no onClick, and Profile/Message are plain `<Link>`s to other routes (:52-53). There is no /social-specific backend seam to "defer."
- **Supporting refutation (docs lens):** by the plan's own rules /social is not EXCLUDED (no money), not WIRED (not in the map), not DEFERRED (no gacha/account app-feature seam) — and the structurally identical `/merchants` (also `'use client'` + useState filter + per-button onClick + hardcoded array) is **already** in STATIC (L248), proving interactivity is not the plan's discriminator (backend/data-need is). "Marketing/content, no backend" holds.
- **Dissent (render, upheld):** `social.png` shows a "Community" user directory (friend-request tabs + per-user Profile/Message/Trade buttons), an account-adjacent surface rather than editorial marketing — but this does not establish a backend seam, so it does not overturn the STATIC placement.
- **Independently verified for this report:** `social/page.tsx:14,30,40,52-53,56` confirm `tab` feeds only CSS and the map is unfiltered. The refutation is correct.
- **Outcome:** **No plan edit.** `/social` stays STATIC.

---

## 4. Counts & bucket reconciliation

**Verdict tally (sums to 41):**
- **MATCH: 33**
- **CONFIRMED-mismatch: 7** — /marketplace, /claw/[slug], /card/[id], /login, /leaderboard, /free, /pack-party
- **DISPUTED: 1** — /social
- **33 + 7 + 1 = 41 ✓**

**Completeness reconciliation (holds):**
- 41 physical `src/app/**/page.tsx` files map 1:1 to 41 URLs (`(account)` route group stripped — 13 account routes, none colliding with top-level; dynamic `[slug]/[id]/[user]/[gen]/[brand]` kept).
- Plan's assigned bucket counts == actual: **11 WIRED + 13 DEFERRED + 10 EXCLUDED + 7 STATIC = 41 ✓**.
- `codeNotInPlan = []`, `planNotInCode = []`. Every code route lands in exactly one bucket; every plan-listed route exists in code.
- Two reconciliation traps handled correctly: (1) the `LeaderboardSection` row spans both `/` and `/leaderboard` — counted once each, not double-counted, `/leaderboard` not missing; (2) the last wiring-map row ("Hero / HowItWorks / Community / Cta / how-it-works / pack-party | static marketing | leave as-is") is **not** a wired route — reading it as non-wiring yields exactly 11.

**⚠ Caveat — the clean 11/13/10/7 total masks 2 wrong placements.** The two bucket mismatches move in **opposite directions and cancel**: `/free` is DEFERRED→STATIC (−1 deferred / +1 static) and `/pack-party` is STATIC→DEFERRED (+1 deferred / −1 static). After correction the totals are unchanged (still 11/13/10/7 = 41), but this is a coincidence of the swap — **2 of the current bucket assignments are confirmed wrong** and must be edited even though the count still reconciles.

---

## 5. Medusa-correctness findings for the WIRED routes

Eight WIRED-row methods + the "Verified Medusa v2 specifics" claims were checked against primary sources (installed `medusa-dev` skills + Context7 `/medusajs/medusa`, cross-checked with docs.medusajs.com).

**CORRECT as written (5):** `sdk.store.product.list()` / `.retrieve()` (marketplace + card); `sdk.store.order.list()` (orders, authenticated-customer-scoped); `sdk.store.customer.retrieve()` / `.update()` (header + settings, self-only); the `sdk.client.fetch()` custom-route pattern for `/store/packs` · `/pulls/recent` · `/leaderboard` · `:id/open` · `:id/sell-back`; and the bolded Stripe provider id `pp_stripe_stripe` (+ `emitEventStep` `eventName`/`data`, `new Medusa({baseUrl, publishableKey})`).

**IMPRECISE / needs correction (4):**

| # | Where | Proposed | Problem | Correction |
|---|---|---|---|---|
| M1 | `MarketplaceClient` category rail — **L217** | `productCategory.list()` | No `sdk.store.productCategory` accessor exists; that's the Admin SDK. | `sdk.store.category.list({ limit, offset, fields })` → `{ product_categories, count, offset, limit }`. *(Same as confirmed route mismatch §2.1.)* |
| M2 | Auth — **L225** | `sdk.auth.register/login` | `sdk.auth.register` returns **only a registration token**; it does NOT create the customer record. | Two-step register: `const token = await sdk.auth.register("customer","emailpass",{email,password})` then `await sdk.store.customer.create({ email, first_name, … })`. `login` is fine. |
| M3 | Buy → checkout — **L217/221/Phase 5 L272** | `sdk.store.cart.*` (`createLineItem`, `complete`) | Both methods exact, but this is not a complete checkout. | Full flow: `cart.create({ region_id })` → `cart.createLineItem(cartId, { variant_id, quantity })` → set email + shipping/billing address + shipping method → create payment collection + initiate Stripe session (`pp_stripe_stripe`) → `cart.complete(cartId)`. `complete()` returns a union: `data.type === 'order'` (success) vs `'cart'` (failure). |
| M4 | Public profile — **L222** (⚠ route verdict was MATCH) | "read-only public stats from the `Pull` ledger **+ customer**" | `sdk.store.customer.*` returns **only the authenticated self** (sole store route `GET /store/customers/me`); retrieving an arbitrary customer by id is **Admin-only**. The "+ customer" implies a built-in fetch that doesn't exist publicly. | A **custom store read route is required**: `GET /store/profiles/:userHandle` via `sdk.client.fetch()`, backed by `query.graph` over the `Pull` ledger joined to a whitelist of public customer fields (name/handle/avatar). Do NOT use `sdk.store.customer.*` for an arbitrary user. |

**Note on M4:** `/profile/[user]` passed its route panel as **MATCH** (the bucket and read-only framing are right), but its *wiring* is imprecise and must be corrected — it appears here and in the §6 edit list despite the MATCH verdict.

**Minor caveats (folded in):** (a) `sdk.store.product.retrieve()` needs a **product ID**, but `/card/[id]` is slug/handle-based today — a handle→id mapping (or `list({ handle })`) is needed; method name still correct. (b) **Unverified sub-claim:** the medusa cross-check confirmed `emitEventStep` and the Stripe id but did **not** independently confirm the exact exported symbol `reserveInventoryStep` from `@medusajs/medusa/core-flows` — treat as unverified pending a core-flows export check. (c) The plan's pure backend-framework primitives (`model.define`, `MedusaService`, `createWorkflow/createStep`, `defineLink`, `db:generate/db:migrate`, etc.) are deferred by the plan (L143-147) to the installed `medusa-dev` skills and were not re-verdicted; they are consistent with those skills.

---

## 6. FINAL VERDICT: **FAIL**

**FAIL** — the plan's route treatment has **7 confirmed mismatches** requiring plan edits (2 bucket misplacements + 4 uncovered-interaction/contract gaps + 1 wrong SDK method), plus **3 Medusa-only wiring imprecisions** not covered by any route mismatch (M2 auth, M3 cart, M4 profile). PASS would require every bucket correct AND wiring appropriate with no confirmed mismatch.

Route completeness itself is clean (41=41, no code-not-in-plan, no plan-not-in-code), and the bucket *counts* reconcile (11/13/10/7) — but two of those bucket *assignments* are confirmed wrong, and the wiring map has the gaps below.

### Exact plan edits needed (union of route-mismatch + Medusa-only refinements, deduped by line)

1. **L217** — `productCategory.list()` → `sdk.store.category.list()` (returns `{ product_categories }`). *(route §2.1 + Medusa M1 — shared.)* Leave `sdk.store.product.list()` unchanged.
2. **L217 / L221 / Phase 5 L272** — buy→checkout is understated: add `cart.create` + customer email + shipping address/method + Stripe payment collection/session before `complete()`; note `complete()` returns a `type:'cart'|'order'` union. *(Medusa M3 — only.)*
3. **L220 / Phase 5 L271** — Open carries only `quantity`; add the **Spice/odds-tier** to the Open call (`POST /store/packs/:id/open` … `quantity, spice/odds-tier` → weighted roll uses the chosen tier's PackOdds), **or** add a sentence that the spice selector stays a display-only mock. *(route §2.2.)*
4. **L221** — extend the "Rewire to" cell beyond "buy → cart/checkout" to cover **Make offer** (`CardDetailClient.tsx:91`) and **Sell**/instant buyback (`:82,:94`, ~88% FMV → sell-back workflow). *(route §2.3.)*
5. **L222** — `read-only public stats from the Pull ledger + customer` → the `+ customer` must be a **custom Pull-ledger read route** (`sdk.client.fetch` over `query.graph` + whitelisted public fields), NOT `sdk.store.customer.*` (self-only). *(Medusa M4 — only; route verdict was MATCH.)*
6. **L225** — (a) register is a **two-step flow**: `sdk.auth.register(...)` (token) then `sdk.store.customer.create(...)` *(Medusa M2)*; (b) account for the login-only **"Forgot password?"** button — wire it (`sdk.auth.resetPassword` / generate-reset-token) or fold into deferred as "(social + password reset = later)" *(route §2.4)*.
7. **L224 / Phase 7 L277-278** — add the static **Prizes** tab note (out of the `weekly|alltime` endpoint) + **pagination** (`&offset=&limit=` + total count) so the "1-9 of 999" pager and 3rd tab are not silently dropped. *(route §2.5.)*
8. **L239-240 ↔ L247** — move **`/free`** from the DEFERRED list to the STATIC list. *(route §2.6.)*
9. **L247-248 ↔ L239** — move **`/pack-party`** from the STATIC list to the DEFERRED list and add a DEFERRED wiring row (`POST /store/pack-parties` join; `GET /store/pack-parties?status=active|completed`; Socket.io `party.filled`). *(route §2.7.)*

**No edit for `/social`** (DISPUTED — refuted; STATIC is correct).
