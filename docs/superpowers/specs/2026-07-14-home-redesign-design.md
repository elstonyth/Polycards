# Home Redesign — "The Drop Board" (mobile-first)

**Date:** 2026-07-14 · **Register:** brand (storefront) · **Status:** approved design, pre-implementation

## Why

Home's job changes: every product tap now routes to `/slots` (the catalog), never a
pack detail page. That makes home a **hype funnel** — the movie trailer, not the
store. This redesign rebuilds the home sections (and lightly the app shell) as a
phone-first editorial scroll story in the shipped Midnight Rip system
(`DESIGN.md`), with hypebeast-drop energy: huge Nekst lockups, tier racks, data
marquees, one white pill per zone.

## Locked decisions (brainstorm 2026-07-14)

| Question | Decision |
| --- | --- |
| Scope | Home sections **+ app shell** (header behavior, tab bar restyle) |
| Home's job | Hype funnel → `/slots` |
| Sections kept | Hero, trust facts, pack shelf, recent pulls — all survive (some merged) |
| Creative latitude | Push the system; fold new patterns back into `DESIGN.md` |
| Tab bar | 5 uniform slots (no FAB/raised center), restyled states + micro-motion |
| Hero concept | Spotlight slab (top chase, rarity glow, tilt) |
| Motion level | Scroll-choreographed scenes; hero slab gets the only bespoke motion (idle float + scroll-linked tilt — no pointer/gyro physics) |
| Product taps | **Plain `/slots`** — no pre-filter, no scroll-to-pack |
| Header | Same contents (logo + balance chip); transparent over hero, solid on scroll |
| New sections | How-it-works strip, payout stat band, leaderboard teaser, VIP/referral teaser |
| Voice | Full hype — ALL-CAPS Nekst punches |
| Desktop | Distinct hero recomposition at ≥1024px |
| Page length | Curated to 6 boards (trust row merged into how-it-works; stats+medals+VIP share one board) |
| Stats source | New Medusa aggregate endpoint (real numbers; no fake zeros) |
| Personalization | One page for everyone |
| Feel reference | Hypebeast drop culture (END./SNKRS energy, **no fake scarcity**) |
| Marquees | Data marquees only (real pulls/values); decorative word loops stay banned |
| Imagery | Cards & packs only — no photography, no decorative type texture |
| Shipping | 3 phased PRs |

## The routing rule

Every **product** tap on home lands on plain `/slots`:
hero CTA pill, marquee band, every shelf tile, rack ghost tiles, JUST PULLED
cards, final CTA pill. Sold-out tiles stay inert (non-links). Non-product links
keep their targets: `All packs →` (`/slots`), `How it works →`
(`/how-it-works`), `See ranks →` (`/leaderboard`).

## Page architecture — six boards

### 01 · HERO — "TOP CHASE IN THE BUILDING"

- Phone: near-full-viewport (`min-h-[calc(100svh-3.5rem)]`), stacked — kicker
  label (Label style, silver, tracked) → slab centered (height-capped at 42svh,
  rarity-hue glow) → value in chase-gold Nekst Display (`RM 21,350`) → card
  name + source pack in one silver line → white pill **`RIP A PACK →`**.
- Slab motion: idle float (±8px, ~6s ease loop) + subtle scroll-linked
  tilt/parallax on exit. Reduced motion: perfectly still, fully lit.
- Data: existing featured logic (most expensive in-stock pack's `topHits[0]`).
- Fallbacks: no chase image → pack art on the pedestal; no packs → hero
  collapses, shelf empty state leads the page.
- Desktop (≥1024px): two-column — type block left (kicker → RM → name → CTA,
  left-aligned), slab right ~420px, glow bleeding toward the type.

### — MARQUEE SEAM (between 01 and 02)

- One slim band streaming the live pulls feed: `Els*** pulled RM 4,200 · 2m`.
  RM values in Nekst white; a small rarity-colored dot per entry; names/time in
  Geist silver. Full-bleed on desktop.
- CSS-only loop (track duplicated, `translateX` keyframes, ~30s), pauses on
  hover/touch. Whole band is one link → `/slots`.
- Reduced motion: static row, `overflow-x-auto` swipeable.
- Data: existing `RecentPull[]` (`value`, `rarity`, `who`, `agoLabel` all
  present). No pulls → band absent.

### 02 · THE SHELF — "RIP A PACK"

> Revised 2026-07-14 (operator): the catalog carries ~one pack per tier, so
> horizontal racks (one tile each) read as dead air. The shelf is a **tier
> ladder** instead — one full-width row per pack.

- Headline lockup `RIP A PACK` + `All packs →` text link.
- One ladder row per pack, ordered by price tier high→low (existing
  `priceTier`/`TIER_COLOR` from `src/lib/price-tier`), catalog order within a
  tier. Row: tier-tinted art pedestal + tier chip in tier hue, pack name,
  `TOP CHASE RM X` line in chase gold (existing per-pack chase lookup;
  `CHASE_LOOKUPS = 16` covers the ladder — rows beyond omit the line), price
  in Nekst right-aligned, quiet `Rip it →` affordance, tier-hue border at
  40%, press-scale. Sold out: dimmed, SOLD OUT label, inert.
- Rows stagger-reveal on scroll.
- Zero packs → single empty-state card.
- Desktop: the top rung spans full width (the ladder's crown); remaining rows
  sit two-up.

### 03 · HOW IT RIPS — trust engine

Three numbered editorial rows; the old trust chips are absorbed here:

```
01  BUY CREDITS   Top up in seconds. RM in, credits out.
02  RIP THE REEL  Spin the pack. Watch the reveal land.
03  IT'S REAL     Every pull is a real graded slab — vault it,
                  ship it, or sell back up to 90%.
```

- Numerals: big Nekst, charcoal-on-ink (near tone-on-tone). Copy: Geist.
  "up to 90%" set in buyback-green-fg. Rows stagger in on scroll.
- `How it works →` ghost link → `/how-it-works`. Desktop: 3-across.

### 04 · JUST PULLED — live proof

- Headline lockup `JUST PULLED` + `● LIVE` chip (2s soft pulse; static dot
  under reduced motion).
- Existing 4s-polling feed, restyled: pedestal spotlight, **value added in
  Nekst** (data already in `RecentPull.value`, currently unused here), rarity
  ring, masked `who` + `agoLabel` silver.
- New pulls fade in (400ms); reduced motion: instant swap.
- Cards → `/slots`. Empty: "No pulls yet — be the first" card.

### 05 · THE GAME — "THE FLOOR PAYS OUT"

One board, three moments (phone stacked; desktop 3-column):

1. **Stat trio** (Phase 3): `RM 512,340 PAID OUT` · `12,408 PACKS RIPPED` ·
   `3,120 COLLECTORS`. Huge Nekst; paid-out in buyback green. Count-up on
   first in-view (~1.2s ease-out; instant under reduced motion). Renders only
   when the endpoint responds — **no fake zeros**.
2. **Top rippers this week:** 3 medal rows (gold/silver/bronze discs, masked
   names, RM totals in Nekst) + `See ranks →` → `/leaderboard`. Uses existing
   leaderboard data; if unavailable → moment hidden.
3. **Loop teaser:** one charcoal card — `100 VIP LEVELS. TWO-TIER REFERRALS.`
   + one Geist sentence + `Learn more →` → `/how-it-works`.

### 06 · FINAL CTA — closer

Full-bleed ink: Nekst lockup `YOUR CHASE / IS WAITING`, white pill
`RIP A PACK →` (→ `/slots`), reassurance line
`Real graded slabs · Up to 90% buyback` in silver. Existing footer below.

## App shell

### Header (all contents unchanged: logo left, balance chip right)

- On `/` over the hero: transparent bg, soft top scrim (black/40 → transparent,
  ~80px) for legibility.
- After `scrollY > 24px` (and on every other route): solid ink + hairline
  bottom border. 200ms bg/border fade, rAF-throttled; reduced motion: instant.
- Tap targets audited ≥44px.

### Tab bar (Daily · Ranks · Home · Vault · Me — unchanged set, uniform)

- Active: white icon+label (as shipped) **+ 4px white dot** that slides between
  slots (150ms spring; teleports under reduced motion).
- Press: icon micro-scale 0.94 with spring back.
- Inactive icons #737373 → #8a8a8a (labels unchanged).
- `data-site-chrome` inert contract untouched. Desktop pill-nav structure
  untouched (restyled states only).

## Motion system

- **Entrances:** extend `useInView`/`Reveal` with a stagger variant — children
  cascade 60–90ms, translate-y 16px + fade, 500ms ease-out, fire-once.
- **Scroll-linked** (slab tilt, header fade): rAF-throttled reads, CSS
  transforms only. **Zero new dependencies.**
- **Micro:** press-scales, marquee loop, LIVE pulse, count-up, tab dot.
- **Reduced motion is a first-class path:** every effect defines its static
  equivalent; content never gated on animation (existing
  `usePrefersReducedMotion` foundation).

## Data & backend

- **Phase 1: no new data.** Hero/chase, marquee + pulls, shelf, leaderboard
  teaser all use existing storefront data sources.
- **Phase 3:** `GET /store/stats` (Medusa custom route in
  `backend/packages/api`) → `{ paidOutRM: number, packsRipped: number,
  collectors: number }`, cached ~60s. Storefront hides the stat row on
  error/absence.

## States

Every board ships skeleton (shaped like content), empty, and error-silent
variants: no packs → shelf empty card; no pulls → marquee absent + feed empty
state; stats down → row hidden; missing images → existing pack-art fallback
patterns.

## Phasing

1. **PR 1 — The page:** six boards + routing rule, existing data only.
   Includes DESIGN.md deltas.
2. **PR 2 — The shell:** header transparency/fade + tab bar dot/micro-motion.
3. **PR 3 — The stats:** Medusa endpoint + stat trio + count-up.

Branch from `origin/master`; isolated worktree per repo convention.

## Verification (per repo law)

`npm run build` + `pwsh scripts/serve-standalone.ps1` (never `next dev`), then
Playwright QA script `scripts/qa-home-redesign.mjs` shooting 390×844 and
1440×900 plus a `prefers-reduced-motion` emulation pass; screenshots into
`docs/research/`, read back and judged. Typecheck/lint hooks + `/code-review`
before each PR.

## DESIGN.md deltas (land with PR 1/2)

- New pattern: **data marquee** (signal-carrying ticker; decorative loops still
  banned).
- New pattern: **board lockup** (numbered editorial section headers).
- New pattern: **hero spotlight slab** (idle float + scroll tilt, earned glow).
- Amend tab bar spec: active dot indicator + press micro-scale (uniform slots
  rule unchanged).
- Amend header spec: transparent-over-hero behavior on `/`.

## Out of scope

`/slots` catalog itself, pack detail/reel, other routes, footer redesign,
personalization (noted as future), formal WCAG conformance (best-effort per
PRODUCT.md).
