# Live Market Price (PriceCharting) — Design Spec

**Date:** 2026-07-01
**Status:** Approved design (revised after Q&A pivot), pending implementation
**Branch:** `feat/live-market-price-pricecharting`

## 1. Goal

Let an admin create a **product** by searching PriceCharting, with the
PriceCharting product ID stored on that product. The product flows through the
normal chain — **Product → inventory → Gacha Card → Pack** — and the
PriceCharting link **carries through automatically**, so once it's a card it
**auto-tracks its grade's live value daily**. Customers see the value **converted
to MYR and marked up 20%**; internal money math (buyback, pack RTP) stays on the
raw USD value.

## 2. Context — what already exists (verified against code)

Medusa v2 / Mercur backend (`backend/packages/api`), Vite admin dashboard
(`backend/apps/admin`, `@mercurjs/admin` 2.1.6), Next.js storefront (`src/`).

Reused by this feature:

- **PriceCharting proxy** — `src/api/admin/pricecharting/{client,search,product}.ts`.
  Auth via `PRICECHARTING_API_TOKEN` (the `t` query param); base
  `https://www.pricecharting.com`; upstream prices are integer **pennies**;
  `PcResult` = `ok | no-token | error`. `search` → `{matches:[{id,name,set}]}`
  (`/api/products?q=`); `product` → `{id,name,set,prices:[{grade,usd}]}`
  (`/api/product?id=`). The **Prices API returns no image.**
- **Grade-tier mapping** (in `product/route.ts`, matches the PriceCharting key
  table): loose=Ungraded, cib=Grade 7, new=Grade 8, graded=Grade 9,
  box-only=Grade 9.5, manual-only=**PSA 10**, bgs-10=**BGS 10**,
  condition-17=**CGC 10**, condition-18=**SGC 10**.
- **`Card` model** (`src/modules/packs/models/card.ts`): `handle` (unique, =
  Product.handle), `name`, `set`, `grader`, `grade`, `market_value` (bigNumber,
  **raw USD** — used by vault worth / pack RTP / buyback), `image`, `price`
  (nullable), `for_sale`, `pokemon_dex`, `sprite_image`.
- **`createCardStep`** (`src/workflows/steps/create-card.ts`): inventory-first —
  requires an existing `product_id`, **reads the image from the product**
  (rejects imageless products), and **mirrors gacha facts onto
  `product.metadata`** (`fmv`, `grade`, `grader`, `set`, `points`, `year`). It
  also links the product to the house seller.
- **`updateCardStep`** (`src/workflows/steps/update-card.ts`): patches the Card
  and re-mirrors the Product.
- **Admin data layer** — `apps/admin/src/lib/{admin-rest,queries,query-keys}.ts`.
- **Money-value consumers** (must stay on raw USD): buyback
  (`src/workflows/steps/buyback-pull.ts` → `buybackAmount(market_value, pct)`)
  and pack RTP (`src/modules/packs/economy.ts` → EV over `market_value`).

**Feasibility constraint (verified):** the stock `/dashboard/products/create`
page **cannot host injected UI.** Medusa exposes admin widget injection zones
only on `list`/`details` pages (no `product.create.*` zone anywhere), and this
Mercur 2.1.6 build **does not wire the widget system at all** —
`mercurDashboardPlugin` only scans **file-based routes** under `src/routes` (+
menu items); the stock create page is a built-in `@mercurjs/admin` component, not
an overridable route. Therefore the PriceCharting entry point is a **new
file-based admin page we own**, not the stock create form. (Forking Mercur's
create page was rejected: high-maintenance, breaks on updates, violates the
starter-contract in `backend/CLAUDE.md`.)

## 3. Terminology

- **Product** = Medusa catalog entity; created first, from PriceCharting.
- **Card** = gacha prize wrapper linked to a Product by `handle`; carries the
  live `market_value`/grade/link. Created later, from an existing product.
- **The customer "who got the product"** = a customer holding the card in their
  **vault** (a `Pull`). Cards are acquired by opening packs; Marketplace is
  feature-flagged **off** (`NEXT_PUBLIC_FEATURE_MARKETPLACE`).
- **Raw value** = PriceCharting's per-grade value (USD).
- **Displayed market price** = `raw × FX(USD→MYR) × multiplier` (MYR).

## 4. Key decisions (all user-confirmed)

1. **Entry point: a custom "Add from PriceCharting" admin page we own** (new
   file-based route). Search PC → pick match + grade → "Add product" → creates a
   Medusa **Product** with image + the PriceCharting link on it. It does **not**
   create a card (that stays a separate, later step). *(Stock product-create page
   can't host this — see §2 feasibility.)*
2. **The PriceCharting link is anchored on the Product**, in `product.metadata`
   (`pc_product_id`, `pc_grade`, `market_multiplier`), and **carried onto the
   Card** at registration — `createCardStep` copies those fields from the product
   onto the Card. So the chain **Product → Card → Pack** stays linked with no
   re-search.
3. **Grade model: one card = one grade.** Product `handle` is unique = card key,
   so grades need distinct handles: `slug(name-grader-grade)`.
4. **Markup + FX are display-only; internals stay raw.** `Card.market_value`
   (and the product's `fmv`) stay **raw USD**; buyback/RTP untouched. Displayed
   MYR = `market_value × fx × multiplier`, computed on read.
5. **Multiplier** per-card, default `1.20`, editable; prefilled on create & edit.
6. **Real USD→MYR conversion** (mid-market, Google-Finance-style), daily-cached,
   admin manual override, last-known fallback. See §8.
7. **Daily refresh only** (PriceCharting recomputes ~24h; API limit **1 req/sec**).
   History = current number only.
8. **Image: try auto-pull, upload as fallback.** The Prices API returns no image,
   so the page attempts a best-effort PriceCharting image fetch and always allows
   the admin to upload/replace. If auto-pull proves unreliable from the
   documented API, it ships upload-only (a build-time investigation — see §12).
9. **Customer surfaces:** vault, card detail / pull-reveal, marketplace listings
   (built now, dormant behind the flag). Customers see only the final MYR price.
   Admin also sees raw + markup + margin.

## 5. Data model

### 5.1 `Card` — new fields (nullable/defaulted so seeded cards migrate)
| Field | Type | Meaning |
|---|---|---|
| `pc_product_id` | `text().nullable()` | PriceCharting id. Set ⇒ auto-tracked; null ⇒ manual. |
| `pc_grade` | `text().nullable()` | Exact tier label (e.g. `"PSA 10"`) → which price field the job reads. |
| `market_multiplier` | `bigNumber().default(1.2)` | Per-card display markup. |
| `pc_synced_at` | `dateTime().nullable()` | Last successful refresh (ops/debug). |

These are **populated by copying from `product.metadata`** at card registration
(§6.2), not typed in the card modal. `market_value` stays raw USD.

### 5.2 Product metadata — new keys
On PriceCharting-sourced products, `product.metadata` gains `pc_product_id`,
`pc_grade`, `market_multiplier` (alongside the existing `fmv`, `grade`, `grader`,
`set`). This is the anchor the Card inherits from.

### 5.3 `FxRate` model (new, single `USD_MYR` row)
`{ pair (unique), rate (bigNumber), source, fetched_at (nullable),
manual_override (bool default false), manual_rate (bigNumber nullable) }`.

A DB migration is required (`medusa db:generate` + `db:migrate`); production must
run it on deploy.

## 6. Backend design

### 6.1 Product-create-from-PriceCharting
New workflow + route `POST /admin/products/from-pricecharting`. Input:
`{ pc_product_id, pc_grade, name, set, grader, grade, market_value (raw USD),
image, price?, for_sale?, market_multiplier? }`. Steps:
1. Create a Medusa Product (title = name, `handle = slug(name-grader-grade)`,
   status from `for_sale`, thumbnail/image, a variant priced in MYR) with
   `metadata` = `{ fmv: market_value, grade, grader, set, pc_product_id,
   pc_grade, market_multiplier }`.
2. Return the product. **No card is created here.** (House-seller link + card
   creation happen later at registration, via the existing `createCardStep`.)

### 6.2 Carry the link Product → Card
Enrich `createCardStep`: when registering a product as a card, **read
`pc_product_id`, `pc_grade`, `market_multiplier` from `product.metadata`** and
write them onto the Card (fallback to null / 1.2 if absent). `updateCardStep`
keeps them editable. So a PriceCharting-sourced product becomes a tracked card
with **no re-search**. Cards added to packs (`PackOdds`) inherit the live value
automatically (packs reference cards).

### 6.3 Daily sync job — `jobs/sync-market-prices.ts` (once/day)
1. Refresh FX once (keep last-known on failure).
2. For each card with `pc_product_id`: `GET /api/product`, read the price field
   for `pc_grade`, write `market_value = raw`, stamp `pc_synced_at`.
   **Throttle ≤1 req/sec.** Guardrails: skip on null/zero/error (keep last-known);
   never crash the batch; log every change.

Future optimization (not v1): the once-per-24h CSV download (Legendary tier) if
the catalog grows to thousands of cards.

### 6.4 Displayed-price computation (on read)
`displayPriceMYR = round2(market_value_USD × usd_myr_rate × market_multiplier)`.
Exposed in: store vault / pull-reveal (customer gets only `marketPriceMyr`) and
admin card reads (raw, fxRate, marketMyr, displayPrice, markup delta).

## 7. Admin UI

- **New page: "Add from PriceCharting"** (file-based route under `src/routes`, a
  sensible path + menu item near Products). Sections: PC **search → match list →
  grade-tier picker** (auto-fills grader/grade/raw value, records
  `pc_product_id`/`pc_grade`); **markup** field (default 20%); **live preview**
  row (`Raw $X · FX 4.xx · Market RM… · Customer sees RM… · Margin RM…` using the
  admin FX read); **image** (best-effort auto-pull + upload/replace); **"Add
  product"** button → `POST /admin/products/from-pricecharting` → toast + link to
  the created product.
- **Cards page/edit** — show a `🔗 Linked · synced <date>` indicator and the
  markup on cards that carry a PC link; allow "Unlink" (clears `pc_product_id`,
  reverts to manual). The existing register modal keeps working unchanged for
  non-PriceCharting products.
- Reuses `admin-rest.ts`/`queries.ts`/`query-keys.ts` + `@medusajs/ui`; follow
  `medusa-ui-conformance`.

## 8. Currency / FX

- `RM = raw_USD × FX(USD→MYR) × multiplier`; display-only, `market_value` stays raw.
- Source: Google Finance has no public API; it shows the **mid-market** rate, so
  we fetch that from a reputable free feed (Frankfurter/ECB or open.er-api),
  **cache + refresh daily**, with an admin **manual override**. On fetch failure,
  keep the **last-known** rate. Rounded to 2 dp (sen).

## 9. Security

- `PRICECHARTING_API_TOKEN` in backend `.env` only; server-side; never in the
  browser or any committed file. **Token value not recorded in this spec.**
- The token was shared in a chat transcript during design → **regenerate it** if
  that transcript is stored untrusted (repo has a prior rotation precedent).
- FX feed + any image fetch are unauthenticated public GETs.

## 10. Dependencies

- Paid PriceCharting subscription + token (provided). Absent ⇒ proxy 503s: the
  page shows manual entry and the job no-ops (keeps last-known).
- A reachable FX endpoint (with manual override fallback).
- DB migration applied in every environment.

## 11. Out of scope (v1)

- Price history / trend charts.
- Batch multi-grade creation.
- Coupling displayed price to checkout or buyback/RTP math (kept raw).
- Backfilling PC links onto the 51 seeded cards (link them via edit if wanted).
- Tracking a product's price **before** it becomes a card (the job tracks cards;
  a not-yet-carded product just holds its snapshot + link).
- CSV-bulk sync path.

## 12. Risks & considerations

- **Image auto-pull is uncertain:** the documented Prices API returns no image;
  a best-effort fetch (product-page image) may be unreliable. Reliable path is
  upload; auto-pull is a bonus verified during the build.
- **FX ≈ Google, not identical;** manual override covers disputes.
- **Displayed vs transactional mismatch** (marked-up sticker vs raw-based
  buyback) is intentional — label it clearly in the UI.
- **Custom page, not the stock create form** — a hard platform limit, not a
  choice; documented in §2.
- **Grade-tier ambiguity:** generic `Grade N` tiers don't name a grader.
- **1 req/sec** bounds the job to ~N seconds for N cards; CSV if it explodes.

## 13. Verification plan

- **Backend:** module test for migration + linked-card refresh; HTTP integration
  for `POST /admin/products/from-pricecharting`, the metadata→card carry, and the
  display-price computation. Money-adjacent ⇒ `test:integration:http`.
- **Job:** unit-test guardrails (null/zero/error → keep last-known; throttle).
- **FX:** unit-test conversion + last-known fallback + manual override.
- **Admin/storefront:** Playwright capture of the Add-from-PriceCharting page,
  the admin margin/linked indicator, and the customer price on vault / reveal.
- **Typecheck:** repo Stop hook type-checks storefront + backend; must be green.
