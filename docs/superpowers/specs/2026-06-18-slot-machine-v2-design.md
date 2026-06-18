# Slot Machine v2 — Design Spec (rev 2: Pokémon-sprite reel)

**Status:** Approved design, **revised** after a mid-build correction (reel = Pokémon pixel sprites, not balls; configurator = reuse `PackDetailClient`).
**Date:** 2026-06-18
**Branch:** `feat/slot-machine-v2` (off `master` @ 37626f6, which has the shipped v1 x1 slot from PR #11)
**Supersedes:** v1 PRD `docs/prd/slot-machine-conversion.md` (balls); and the rev-1 ball direction of this very spec — the ball assets/`BallToken`/`balls.ts`/`ball-alpha.ts` built in the first Phase-A pass are **dead** and get removed.

---

## 1. Goal

`/slots` configurator (reusing the `/claw` `PackDetailClient`) → immersive full-screen `/slots/[slug]` reveal: the chosen **1–3 packs** appear front-facing → one tap peels them open → each becomes a **vertical reel of Pokémon pixel sprites** that scroll ↓ and stop staggered L→R → the landed Pokémon **grows and glows a price-tier color**. Win-rate lock stays server-authoritative and untouched. Fix the two reported bugs by construction.

## 2. The reel — Pokémon pixel sprites + price-tier glow (the core change)

- **Reel cells are Pokémon pixel sprites**, reusing the repo's Pokédex sprite source: `spriteGif(dex)` (animated PokeAPI "showdown" sprite) with `spritePng(dex)` fallback, from `@/lib/mock/pokedex`. Rendered with a plain `<img>` (the Pokédex already does this — no `next/image` remote-host config needed). The sprite "runs"/idles as it scrolls.
- **Card → Pokémon:** the won card's name contains its Pokémon (e.g. "Jet-Black Spirit **Celebi** V CGC 10" → Celebi). A helper `pokemonFromCard(name)` matches the longest `POKEDEX_NAMES` entry present in the card name → its `dex` → `spriteGif(dex)`. A Pikachu sprite landing means a Pikachu-related card prize. **The same Pokémon can land at different price tiers.**
- **Decoy cells:** random Pokémon sprites (any dex) so the reel reads as a varied scroll; only the winner cell is the real card's Pokémon.
- **Landing — grow + glow:** when a reel settles, the winning sprite **scales up** and gets a **glow ring/aura colored by the card's price tier** (§3). This is the reveal beat (replaces the v1 ball-casing highlight).

## 3. Price-tier system (6 tiers)

The landed Pokémon's glow color encodes a **price tier** derived from the won card's market value. Six tiers (operator-tunable thresholds — confirm bands):

| Tier      | Color                 | Proposed band (market value, USD) |
| --------- | --------------------- | --------------------------------- |
| common    | gray `#9ca3af`        | `< 25`                            |
| uncommon  | light blue `#7dd3fc`  | `25 – 99`                         |
| rare      | deep blue `#2563eb`   | `100 – 499`                       |
| mythical  | purple `#a855f7`      | `500 – 1,999`                     |
| legendary | bright pink `#f472b6` | `2,000 – 9,999`                   |
| immortal  | orange `#fb923c`      | `≥ 10,000`                        |

- A pure helper `priceTier(value: number): Tier` buckets the value; `TIER_COLOR[tier]` gives the glow rgb. **Tier is by price, independent of the card's `rarity` field** (so one Pokémon at $30 glows light-blue, the same Pokémon at $3,000 glows bright-pink).
- **Thresholds are a §13 open item** — the bands above are a sensible default pending the operator's real numbers.

## 4. Reported bugs (folded in)

1. **Win shown mid-spin** → win label/sound/price + the grow-glow fire only on the reel's **settle**, never during the scroll. By construction.
2. **Layout shift / footer expansion** → `/slots/[slug]` is a **fixed immersive full-screen** surface (no site header/footer, no scroll), controls in fixed positions, nothing reflows mid-spin.

## 5. Routes

| Route           | Role                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/slots`        | **Configurator — reuse the `/claw` `PackDetailClient`**, parameterized so its links/CTA route to `/slots/[slug]` instead of opening the claw overlay. Quantity becomes **packs 1–3**. (Reuse, don't reimplement.) |
| `/slots/[slug]` | **Immersive full-screen reveal**: N front-facing packs → tap → peel → N vertical Pokémon reels → stop staggered L→R → grow+glow winner. No site chrome. `count` via query.                                        |

`/claw/*` untouched. Implementation approach for reuse: extract the shared configurator out of `PackDetailClient` (or add a `mode: 'claw' | 'slots'` prop driving the CTA target), so both routes render one component. Prefer the smallest change that avoids a forked copy.

## 6. Reveal sequence

1. **N packs front-facing** (1–3), no skew, centered, "tap to open". Packs use the existing **pack foil art** (`pack.image`).
2. **One tap opens all** packs (peel, Motion + CSS `clip-path`) — **no spin yet**.
3. **Vertical Pokémon reels revealed, idle.**
4. **User taps SPIN** → reels scroll ↓ together, **stop staggered L→R**, land the winner Pokémon on the shared horizontal payline.
5. **Grow + glow + reveal** (win label/sound/price) — only after full stop.
6. **"View card"** button → modal with the graded card slab; **30s instant sell-back** per won column (focused-column for N).

## 7. Backend — `open-batch` (multiplier)

`POST /store/packs/:slug/open-batch { count: 1..3 }`, **all-or-nothing** (one atomic `count×price` debit, N rolls in one workflow, saga rollback, affordability pre-check). Each roll an independent server-side draw → **win-rate lock preserved per roll**; no `weight`/`computeOdds` to the client. Returns `{ rolls:[{pull,card,buyback}], price, total_charged, balance }`. (Same as rev-1 §7.)

## 8. Win-rate lock — unchanged

Outcomes decided server-side over normalized `PackOdds.weight` before any UI mounts; the reel only _displays_ `res.card`. The Pokémon sprite + price tier are **derived from the won card** (cosmetic mapping), deciding nothing.

## 9. Sell-back & view-card

Reuse the already-extracted `SellBackPanel` (30s instant + countdown + confirm + server buyback); focused-column for N. "View card" modal shows the graded slab (`card.image`).

## 10. Full-screen, responsive, a11y

Immersive (no `SiteHeader`/`SiteFooter` on `/slots/[slug]`); body scroll locked during reveal; `100dvh`, no layout shift; ≥48px controls; single `role="status" aria-live` announcing once on final settle; `aria-busy` during spin; dialogs get `role="dialog" aria-modal` + Escape + focus; reduced-motion degrades every surface (no scroll/peel/glow-pulse — winners centered + glow shown statically).

## 11. Reuse map

| Reuse                                                                             | For                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `PackDetailClient` (`/claw/[slug]`)                                               | the `/slots` configurator (parameterized, not forked) |
| `@/lib/mock/pokedex` (`spriteGif`/`spritePng`/`POKEDEX_NAMES`/`getGeneration`)    | reel Pokémon sprites + card→Pokémon lookup            |
| `RouletteClient`'s `Thumb`/`<img>` sprite pattern (`PokeSprite` in PokedexClient) | reel cell rendering with gif→png fallback             |
| `reelTarget`/`buildStrip` (`src/lib/reel.ts`)                                     | reel landing math — **adapt X→Y (vertical)**          |
| `SellBackPanel`, `useSound`, `motion.ts` tokens, win-burst keyframes              | sell-back, SFX, peel + grow/glow polish               |
| `openPack`/`revealPull`/`getCreditBalance`/`sellBackPull` + new `openBatch`       | rolls + sell-back                                     |

## 12. Removed (superseded ball work)

The first Phase-A pass built a ball direction that is now wrong. **Remove**: `src/app/slots/[slug]/BallToken.tsx` (revert to v1 or delete if the v2 reel replaces it), `src/lib/balls.ts`, `src/lib/ball-alpha.ts` (+ tests), `scripts/process-balls.mjs`, `public/images/balls/*`. (Single "remove superseded ball assets" commit.) The flood-fill helper has no remaining consumer.

## 13. Testing

- **Unit (vitest):** `pokemonFromCard(name)` (parse Pokémon → dex), `priceTier(value)` (6-tier buckets + boundaries), vertical reel math (`reelTargetY`), `buildStrip` (reused), `open-batch` shaping.
- **Backend integration (jest):** `open-batch` all-or-nothing (1 debit + N pulls / whole-batch reject + rollback; lock per roll; cap 3).
- **Playwright (prod build :4000):** configurator → Play → packs → tap → SPIN → reels land staggered → grow+glow only after stop → COST debits N×price → sell-back → view-card; reduced-motion; full-screen no-layout-shift; win-rate-lock regression.

## 14. Phased rollout (revised)

- **Phase A′ — Configurator + reel-token swap:** remove ball work (§12); reuse `PackDetailClient` for `/slots` (route to `/slots/[slug]`); build `PokemonToken` (sprite via `spriteGif` + grow/glow by tier) + `pokemonFromCard` + `priceTier` (TDD).
- **Phase B — Full-screen reveal + vertical Pokémon reel:** immersive route; adapt reel math to vertical; `SlotReelColumn`/`SlotReelStack` (N columns, shared payline, staggered L→R, winner grow+glow); win-after-stop.
- **Phase C — Packs + peel:** N front-facing packs (pack foil art); one-tap peel (`PackPeel`, Motion + CSS clip-path, swappable); idle→SPIN gate.
- **Phase D — `open-batch` backend** (all-or-nothing) + `openBatch` action; wire N reels to N rolls.
- **Phase E — Sell-back + view-card + polish:** focused-column sell-back, view-card modal, SFX, big-win burst, reduced-motion, a11y, Playwright sign-off.

## 15. Open items (confirm)

1. **Price-tier thresholds** (§3) — confirm the 6 bands or give real numbers.
2. Decoy sprite pool size/range per reel (default: random across all dex, reshuffled per spin).
3. Pack-peel choreography (Phase C visual tune).
4. Whether `/slots` keeps the demo spin (default: yes).

---

**Animation engine:** Motion (`motion/react`, installed) + CSS `clip-path` peel + CSS-transform vertical reel; `motion-framer` skill installed; peel as a swappable component (Rive/Lottie later). Research (find-skills + last30days): Remotion/Hyperframes are video engines (excluded); Rive/Lottie are designer-authored (deferred).
