# Polycards

The ubiquitous language of the trading-card-pack collectibles platform: gacha
pack opening, a site-credit economy, buyback, a card vault, a VIP/referral
program, and physical delivery. One shared context spans the Next.js storefront
(`src/`) and the Medusa + Mercur backend (`backend/`) — the terms below mean the
same thing on both sides of the wire.

This is a glossary, not a spec. It records what each term _is_, and — where the
codebase uses several words for one idea, or one word for several ideas — which
word is canonical.

## Opening a pack

**Pack**:
A gacha pack listing a customer can open (slug, MYR price, category, buyback
rate, stock). The thing you open.
_Avoid_: product (a Card is backed by a Medusa Product — a Pack is not)

**Card**:
The graded collectible metadata that is a pack's prize — name, set, grader,
grade, USD fair-market value, slab image. Backed by a Medusa Product for
inventory and checkout. A Card carries no Rarity (see Rarity).
_Avoid_: item, prize, product

**PixelPokemon**:
The pixel sprite a Card links to by id. Display art, not a prize on its own.

**PackOdds**:
The gacha table — one row per (Pack, Card) with a relative weight. A card's roll
chance is `weight / Σ(weights in the pack)`. Rarity lives here, per pack, not on
the Card.
_Avoid_: odds, weights (when the row/table entity is meant)

**Open**:
The command that spends credit, rolls PackOdds, and writes a Pull. The paid,
server-side act (`POST /store/packs/[slug]/open`).
_Avoid_: buy, purchase, spin, draw

**Pull**:
The record of one prize acquisition — a pack Open (`source='pack'`) or a product
win from a Reward Draw (`source='reward'`). The append-only source of truth for
the live-pulls feed, the leaderboard, and the Vault.
_Avoid_: spin, roll, result

**Vault**:
A customer's held Pulls — the cards they keep. Not a table: a vault item is a
Pull whose status is `vaulted`.
_Avoid_: inventory, collection, wallet

**Delivery Order**:
A customer's request to physically ship one or more vaulted Pulls, with its own
`requested → packing → shipped → delivered → canceled` status. A shipment being
_delivered_ is a different fact from a Pull being _delivered_ — do not conflate
the two lifecycles.
_Avoid_: order (a DeliveryOrder is not a Medusa checkout order)

## Two six-name axes — do not conflate

Both use the same six words. They are different measurements.

**Rarity**:
A card's per-pack gacha grade on PackOdds — `Immortal · Legendary · Mythical ·
Rare · Uncommon · Common` (capitalized). Drives the odds weight split and the
tier badge. The same Card can be a different Rarity in a different Pack.
_Avoid_: tier (Tier is the price axis below)

**Tier**:
A card's glow bucket derived from its market value — `common · uncommon · rare ·
mythical · legendary · immortal` (lowercase). Bucketed in MYR bands (`< RM 25` …
`≥ RM 10,000`), and explicitly independent of the card's Rarity.
_Avoid_: rarity (Rarity is the odds axis above); level (Level is VIP)

## Money

All ledger and price money is **MYR** (Ringgit, RM) as a decimal. The single
exception is a card's USD fair-market value, converted to MYR at one pricing
seam.

**FMV** / **Market Value**:
A card's USD fair-market value (from PriceCharting). The only USD in the system.
_Avoid_: price (Price is the MYR sale/pack amount)

**Credit**:
A customer's spendable site balance, in MYR. Held as an append-only ledger
(CreditTransaction); there is no mutable balance column.
_Avoid_: cash, money, wallet, points

**Balance**:
The sum of a customer's CreditTransaction amounts.
_Avoid_: available (Available is the narrower spendable-now figure below)

**External-Funded**:
The portion of a balance or spend backed by real-money top-up, as opposed to
buyback or commission credit. The basis for VIP spend.
_Avoid_: real money, deposited

**Available** vs **Locked**:
Commission credit is Locked (not yet spendable) while pending-and-unmatured or
suspended; Available is the post-maturity spendable amount. Regular top-up and
buyback credit is always Available.

## Selling and cashing out

**Buyback**:
Selling a Pull back to the house for credit. The Instant rate (the pack's
`buyback_percent`, within the ~30s reveal window) applies at the reveal; the
Flat / Vault rate applies to any later sell from the Vault.
_Avoid_: refund, sellback

**Marketplace Listing** (`for_sale`):
Listing a Card for sale to other users on the marketplace. Distinct from
Buyback (which sells to the house).
_Avoid_: sell (ambiguous between this and Buyback — say which)

**Cashout**:
Converting site credit out to real money (ledger reason `cashout`).
_Avoid_: withdraw (that word is the physical reward-shipment flow — see Delivery
Order and `rewards/withdraw`), payout

## Rewards, VIP, and referrals

**VIP Level**:
A customer's rung 1–100, reached by cumulative external-funded spend. Unlocks a
Reward Box tier, avatar frames, and referral rates.
_Avoid_: rank, tier (Tier is the price axis)

**Reward Box**:
The daily free-prize pool attached to a VIP tier.

**Reward Draw**:
A customer's daily free draw from their Reward Box — free, daily-capped,
VIP-gated. Distinct from a pack Open, though a product prize is delivered as a
`source='reward'` Pull.
_Avoid_: spin, open (those are the paid pack flow)

**Voucher**:
A MYR credit grant awarded at a VIP milestone.

**Frame** / **Avatar Frame**:
A cosmetic avatar border unlocked at every tenth VIP level.
_Avoid_: badge, tier, level

**Commission**:
Referral earnings paid to a sponsor — Direct (a recruit's own opens) or Override
(deeper referral generations, a.k.a. team). Paired 1:1 with a credit-ledger row.
_Avoid_: referral bonus, kickback

**Sponsor** / **Recruit**:
The two roles of a referral relationship — the sponsor earns Commission on the
recruit's opens.
_Avoid_: referrer/referee (pick sponsor/recruit)

## Operator economy

**RTP** (Return-to-Player):
A pack's expected returned value as a percent of its price (`EV / price × 100`).
Above 100 means the operator loses money on that pack.

**EV** (Expected Value):
The odds-weighted expected FMV of one Open of a pack.

## UI only — deliberately not domain

These are presentation words. They must not stand in for the domain terms above.

**Spin**:
Client-side demo theater for logged-out visitors — samples the _published_ odds
and shows a card. No Open, no Pull, no credit, no stock.
_Avoid_: using "spin" for a real Open or Pull

**Reel** / **HReel** / **VaultReel**:
Pure slot-strip geometry and physics primitives that animate the reveal. UI math,
no domain meaning.

**Slab**:
The baked graded-card composite image (frame + photo, one WebP) shown for a
graded Card.
