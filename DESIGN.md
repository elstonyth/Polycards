---
name: Pokenic
description: Dark-premium mobile-first app for ripping graded-card packs — the card is the only thing that glows.
colors:
  ink-black: '#0a0a0a'
  charcoal: '#171717'
  graphite: '#262626'
  smoke: '#333333'
  hairline: '#ffffff1a'
  paper-white: '#fafafa'
  silver-text: '#a3a3a3'
  chase-gold: '#ffb020'
  buyback-green: '#4ade80'
  alarm-red: '#f87171'
  tier-starter: '#ef4444'
  tier-silver: '#60a5fa'
  tier-gold: '#eab308'
  tier-diamond: '#a78bfa'
typography:
  display:
    fontFamily: 'Nekst, ui-sans-serif, system-ui, sans-serif'
    fontSize: 'clamp(1.75rem, 5vw, 3rem)'
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: '-0.02em'
  headline:
    fontFamily: 'Nekst, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.375rem'
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: '-0.01em'
  title:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1rem'
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.9375rem'
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.75rem'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '0.02em'
rounded:
  sm: '8px'
  md: '12px'
  lg: '16px'
  pill: '999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '40px'
components:
  button-primary:
    backgroundColor: '{colors.paper-white}'
    textColor: '{colors.ink-black}'
    rounded: '{rounded.pill}'
    padding: '14px 24px'
  button-primary-hover:
    backgroundColor: '#ffffff'
    textColor: '{colors.ink-black}'
    rounded: '{rounded.pill}'
  button-secondary:
    backgroundColor: '{colors.graphite}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.pill}'
    padding: '14px 24px'
  chip:
    backgroundColor: '{colors.graphite}'
    textColor: '{colors.silver-text}'
    rounded: '{rounded.pill}'
    padding: '6px 14px'
  chip-selected:
    backgroundColor: '{colors.paper-white}'
    textColor: '{colors.ink-black}'
    rounded: '{rounded.pill}'
    padding: '6px 14px'
  card:
    backgroundColor: '{colors.charcoal}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.lg}'
    padding: '16px'
  balance-chip:
    backgroundColor: '{colors.graphite}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.pill}'
    padding: '8px 6px 8px 14px'
  input:
    backgroundColor: '{colors.graphite}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.md}'
    padding: '12px 14px'
---

# Design System: Pokenic

## 1. Overview

**Creative North Star: "The Midnight Rip"**

A collector in bed at 11pm, phone the only light in the room, deciding whether to rip one more pack. Everything in this system serves that scene: near-black chrome that disappears, card art and tier color that glows out of it, money values that read instantly, and a thumb-reach bottom tab bar because this is an app you hold, not a website you visit. The structural language is borrowed from the best Malaysian graded-card storefronts (90scard's pill CTAs, trust rows, and medal-ranked standings; luka.game's pack-tier hub and daily-login calendar) but rendered on Pokenic's own dark neutral base — never their light chrome, never their fire.

The system explicitly rejects (from PRODUCT.md): cheap gacha/casino neon and coin-shower spam; corporate SaaS blue-gray sameness; web3/NFT purple-gradient clutter; generic Shopify-default e-commerce. Hype is earned through real stakes (rarity, RM value, live pulls) and reveal pacing — never manufactured with confetti or countdown pressure.

**Key Characteristics:**

- Dark tonal layering (ink → charcoal → graphite), zero decorative shadows
- The card is the hero: chrome is monochrome; only cards, tiers, rarity, and money carry color
- White pill CTAs on dark — one primary per zone, impossible to miss
- Nekst Black display type for headings, ranks, and RM values; quiet Geist for everything else
- Phone-first: bottom tab bar, thumb-height CTAs (≥44px), sticky action cards

## 2. Colors

A committed dark palette where chrome stays monochrome and every hue is a signal: tier, rarity, or money.

### Primary

- **Paper White** (#fafafa): The action color. Primary CTA pills, selected tab icons, selected chips. On this base, white IS the accent — its rarity against the dark is what makes buttons read.
- **Chase Gold** (#ffb020): Prize and value moments only — top-chase values, leaderboard "your rank" numbers, VIP milestones, streak flames. The color of the thing you're chasing.

### Secondary

- **Buyback Green** (#4ade80): Money-positive only — credited amounts, buyback quotes, reward chips, "+RM" deltas. Never decoration, never success-toast filler.
- **Alarm Red** (#f87171): Errors and destructive confirmation only.

### Tertiary — Tier Band

- **Starter Red** (#ef4444), **Silver Blue** (#60a5fa), **Gold** (#eab308), **Diamond Purple** (#a78bfa): Pack-tier identity colors for hub tier cards and tier filter chips, applied as card-surface tints and borders (like 90scard's colored pack cards). Rarity glow on individual cards keeps its existing per-rarity axis (including immortal orange) — tiers color packs, rarity colors cards.

### Neutral

- **Ink Black** (#0a0a0a): Page background. The dark room.
- **Charcoal** (#171717): Section surface, cards at rest.
- **Graphite** (#262626): Elevated/interactive surfaces — inputs, chips, secondary buttons, balance chip.
- **Hairline** (#ffffff1a): The only border color. 1px, 10% white.
- **Paper White / Silver Text** (#fafafa / #a3a3a3): Primary / secondary text. Body text never drops below silver — #737373 gray on charcoal fails contrast and is prohibited for running text.

**The Signal Rule.** Every non-neutral color on screen must mean something a collector can name: a tier, a rarity, money in, or danger. If a color is there "for energy", delete it.

## 3. Typography

**Display Font:** Nekst (Black 900, self-hosted) with system sans fallback
**Body Font:** Geist with system sans fallback

**Character:** Nekst Black is the hype voice — compact, heavy, slightly condensed, built for "#1ST" and "RM 21,350". Geist is the trust voice — neutral and legible for balances, terms, and buyback math. The pairing is loud headline, calm ledger.

### Hierarchy

- **Display** (900, clamp(1.75rem–3rem), 1.05): Screen titles, reveal moments, rank numerals. Uppercase allowed here only.
- **Headline** (900, 1.375rem, 1.15): Section heads ("LIVE STANDINGS", "JUST PULLED"), card names in reveal.
- **Title** (Geist 600, 1rem): Card/list item names, modal titles.
- **Body** (Geist 400, 0.9375rem, 1.55): Descriptions, explainer prose. Max 70ch.
- **Label** (Geist 600, 0.75rem): Chip text, tab labels, stat labels, timestamps. Sentence case; uppercase reserved for tiny stat labels ("TOP CHASE", "YOUR RANK") in the 90scard idiom.

**The Money Is Display Rule.** RM values that matter (top chase, balance, buyback quote, rank prize) are set in Nekst Black — money is content, not metadata. Incidental amounts (timestamps of a feed row) stay Geist.

## 4. Elevation

Flat, tonally layered, glow-reserved. Depth comes from the three-step neutral ramp (ink page → charcoal card → graphite control), separated by hairline borders — never from drop shadows. The single exception: **rarity/prize glow** (a soft colored `box-shadow` matched to the rarity or tier hue) on card art, reveal moments, and the top-chase highlight. Overlays (top-up sheet, dialogs) sit on a black/60 scrim with the surface at charcoal.

**The Glow Is Earned Rule.** A glow appears only when its color is inherited from the thing glowing (a card's rarity, a tier's hue, chase gold on a prize). Decorative ambient shadows are prohibited — if it looks "soft and floating", it's wrong; this system is matte with jewels in it.

## 5. Components

### Buttons

- **Shape:** Full pill (999px), height ≥48px for primary, ≥40px secondary.
- **Primary:** Paper White bg, Ink Black text (#fafafa/#0a0a0a), Geist 600. One per zone (screen footer, sticky card, sheet).
- **Hover/Active:** Pure white bg + scale 0.98 on press; focus-visible ring 2px white/40.
- **Secondary:** Graphite bg, white text. **Ghost:** transparent, hairline border.
- **Disabled:** Graphite bg, #737373 text, no interaction affordance.

### Chips (filters, quick amounts, reward tags)

- **Style:** Graphite pill, Silver label text; selected = Paper White bg, Ink text (exactly the 90scard Daily/Weekly toggle inverted).
- **Money chips:** Buyback Green text on green/10 tint bg ("+RM 1,000").

### Cards / Containers

- **Corner Style:** 16px (cards), 12px (rows/inputs). Never above 16px on containers; pills are for buttons/chips only.
- **Background:** Charcoal; interactive rows Graphite on press.
- **Border:** Hairline 1px; tier cards use a 1px border + surface tint of their tier color.
- **Internal Padding:** 16px; 20px on feature cards.

### Inputs / Fields

- **Style:** Graphite bg, 12px radius, no border at rest, white text, placeholder #a3a3a3 (never darker).
- **Focus:** Hairline brightens to white/40; no glow.
- **Amount input (top-up):** Nekst Black display size with "RM" prefix label.

### Navigation

- **Bottom tab bar (mobile, the primary nav):** 5 slots with the shipped labels **Daily · Ranks · Home · Vault · Me** (Daily = daily reward, Ranks = leaderboard; short labels fit 10px tab type). Ink Black bar, hairline top border, safe-area padding. Active tab: Paper White icon + label at strokeWidth 2.25; inactive: #737373. All five tabs render uniform — no raised center tab, no floating FAB circle. The bar carries `data-site-chrome` so immersive surfaces (the reel) can inert it.
- **Header:** Ink Black, logo left; right side balance chip (Graphite pill: "RM 4.49" + white "＋" disc) opening the top-up sheet, present on every screen.
- **Desktop (≥1024px):** the tab bar hides and the same five destinations render as pills inside the header row (logo left, nav center-left, balance chip right); content column widens, same components. This section is the nav contract — `src/components/app-shell/tabs.ts` implements it.

### Signature: Sticky Stat Card

The 90scard-derived anchored card (bottom of Leaderboard: "YOUR RANK #458 / TO TOP 10 RM 29,701 / [Buy Now]"): Charcoal surface, 16px radius, hairline border, floats above the tab bar with 12px inset. Used for your-rank, sell-back confirmation totals, and claim summaries. Label row in uppercase Label style, values in Nekst Black, one primary pill.

## 6. Do's and Don'ts

### Do:

- **Do** keep chrome monochrome: ink/charcoal/graphite/white everywhere a color isn't a tier, rarity, or money signal (The Signal Rule).
- **Do** set meaningful RM values in Nekst Black at Title size or larger, with Buyback Green reserved for money-in and Chase Gold for prizes.
- **Do** give every interactive element all states: default, press (scale 0.98), focus-visible ring, disabled, loading (skeleton, not spinner).
- **Do** honor `prefers-reduced-motion` on every animation via the existing `usePrefersReducedMotion`/`Reveal` foundation — content is always visible immediately.
- **Do** keep tap targets ≥44px and the primary CTA inside thumb reach on phone screens.
- **Do** use skeletons shaped like the content (card tiles, list rows) for loading.

### Don't:

- **Don't** ship "cheap gacha / casino" energy: no slot-machine neon, no coin showers, no fire splash screens, no fake urgency timers (PRODUCT.md anti-reference, verbatim).
- **Don't** drift to "corporate SaaS / fintech" sterile blue-gray or icon-card dashboard grids (PRODUCT.md anti-reference).
- **Don't** touch "web3 / NFT" purple degen gradients or glossy 3D coins (PRODUCT.md anti-reference) — Diamond Purple lives on tier cards only.
- **Don't** build a "generic e-commerce" product grid; the hub is an experience shelf, not a catalog (PRODUCT.md anti-reference).
- **Don't** use gradient text, glassmorphism-by-default, side-stripe borders (`border-left` accent), or decorative grid/stripe backgrounds. Prohibited outright.
- **Don't** put body text below Silver (#a3a3a3) on dark surfaces; muted-gray-on-charcoal is the #1 legibility failure.
- **Don't** round containers past 16px or add drop shadows to buttons/cards — matte surfaces, hairline edges, earned glow only.
- **Don't** gate content behind animations; a reveal enhances an already-visible default.
