<!-- Generated: 2026-06-08 | Files scanned: backend/packages/api/src/modules + migrations | Token estimate: ~700 -->

# Data Model

Postgres 16 (`postgres://medusa:medusa@localhost:5432/medusa`, ~180 tables). The custom
**packs** module adds 4 tables; everything else is Medusa/Mercur core. Medusa values are
**decimals, not cents**.

## Custom: packs module (`src/modules/packs/models/`)

```
Pack (table: pack)                              ── slug is the business key + route slug
  id · slug (unique) · title · category · price · image · boost(bool) · rank(int) · status

Card (table: card)                              ── handle is the business key
  id · handle (unique) · name · set · grader · grade · rarity(enum: Legendary|Epic|Rare|
  Uncommon|Common) · market_value (bigNumber → numeric + raw_market_value jsonb) · image

PackOdds (table: pack_odds)                      ── the weighted gacha table
  id · pack_id (= Pack.slug) · card_id (= Card.handle) · weight(int)
  // pull chance = weight / Σ(weights in pack)

Pull (table: pull)                               ── the ledger (one row per open)
  id · customer_id (= Medusa customer cus_…) · pack_id · card_id (won) · order_id(nullable) · rolled_at
  // source of truth for the live-pulls feed + (future) leaderboard
```

### Relationships (joined IN-MODULE by business key — NO Medusa links yet)
```
Pack 1──* PackOdds *──1 Card        (PackOdds.pack_id=slug, PackOdds.card_id=handle)
Pull *──1 Pack (pack_id=slug)  ·  Pull *──1 Card (card_id=handle)  ·  Pull *──1 customer (customer_id)
```
`market_value` is normalized to a JS number at every read boundary (`Number(card.market_value)`).
Deferred: `defineLink` pack↔product and card↔product (a payment/inventory concern).

### Migrations
`Migration20260608035226` → `pack` (Phase 4) · `Migration20260608045250` → `card`, `pack_odds`,
`pull` (Phase 5a). Generate/apply: `corepack yarn medusa db:generate packs` → `db:migrate`.

## Core (Medusa + Mercur) — relevant tables
```
product · product_variant · price · price_set          16 card products (house seller), 1 variant each (Format:Slab, USD)
product_product_seller_seller                          product↔seller links (Mercur visibility)
seller                                                  1 "house" seller (handle=house, status=open) owns all cards
customer · customer_account                             emailpass customers (Phase 3)
order · order_line_item                                 empty until checkout (payment dropped)
region (USD + EUR) · sales_channel · api_key            publishable key apk_01KTDZ… → sales channel
```
Card display fields (fmv/points/grade/grader/set/rarity/year) also mirrored on `Product.metadata`
so the marketplace renders from the Product alone (request `fields=+metadata`).

## Seeded volumes
16 card products · 1 house seller · 21 packs · 16 gacha Cards · 336 PackOdds · Pull = grows at runtime.
