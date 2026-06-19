# Slot Machine v2 — Design Spec (rev 3: Pokémon-sprite reel)

**Status:** Approved design, **revised** after a mid-build correction (reel = Pokémon pixel sprites, not balls). Rev 3 closes a fresh-eyes review (gaps G1–G7): configurator is a **lean dedicated `/slots` page** (NOT a fork of `PackDetailClient`); chrome suppression via **route groups**; `pokemonFromCard` gets normalization + a non-Pokémon fallback; price-tier value source pinned + a QA-data note.
**Date:** 2026-06-19
**Branch:** `feat/slot-machine-v2` (off `master` @ 37626f6, which has the shipped v1 x1 slot from PR #11)
**Supersedes:** v1 PRD `docs/prd/slot-machine-conversion.md` (balls); and the rev-1 ball direction of this very spec — the ball assets/`BallToken`/`balls.ts`/`ball-alpha.ts` built in the first Phase-A pass are **dead** and get removed.

---

## 1. Goal

`/slots` configurator (reusing the `/claw` `PackDetailClient`) → immersive full-screen `/slots/[slug]` reveal: the chosen **1–3 packs** appear front-facing → one tap peels them open → each becomes a **vertical reel of Pokémon pixel sprites** that scroll ↓ and stop staggered L→R → the landed Pokémon **grows and glows a price-tier color**. Win-rate lock stays server-authoritative and untouched. Fix the two reported bugs by construction.

## 2. The reel — Pokémon pixel sprites + price-tier glow (the core change)

- **Reel cells are Pokémon pixel sprites**, reusing the repo's Pokédex sprite source: `spriteGif(dex)` (animated PokeAPI "showdown" sprite) with `spritePng(dex)` fallback, from `@/lib/mock/pokedex`. Rendered with a plain `<img>` (the Pokédex already does this — no `next/image` remote-host config needed). The sprite "runs"/idles as it scrolls.
- **Card → Pokémon (G4):** the won card's name contains its Pokémon (e.g. "Jet-Black Spirit **Celebi** V CGC 10" → Celebi). A pure helper `pokemonFromCard(name): { dex: number; name: string } | null` does a **normalized longest-match**: lowercase, strip punctuation (`-`, `'`, `:`, `.`) and gender symbols, collapse whitespace on **both** the card name **and** every `POKEDEX_NAMES` entry (the list is 1025 names, Gen 1–9, already punctuation-stripped: "Farfetchd", "Ho Oh", "Porygon Z", "Type Null"), then pick the **longest** normalized entry that appears as a substring → its `dex` (= index + 1) → `spriteGif(dex)`. Longest-match disambiguates nested names ("Mr Mime" beats "Mime"). Naïve substring on raw strings would miss real card punctuation ("Ho-Oh", "Farfetch'd", "Type: Null") and form suffixes ("Deoxys Normal" ≠ "Deoxys ex") — normalization is mandatory, not optional.
- **No-match fallback (G5 — non-Pokémon cards):** the backend can draw trainer/energy/item cards with no Pokémon in the name → `pokemonFromCard` returns `null`. The reel cell then shows a **neutral fallback** (the card's own `card.image`, no sprite); the glow still fires from `priceTier` (§3). Never crash or render a blank cell on a null match.
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
- **Value source (pinned):** feed `priceTier` the **backend `market_value`** (decimal USD) surfaced as `marketValue` on the `openPack`/`open-batch` result — NOT the mock `fmv`/`price` fields. The won card's value is server-authoritative.
- **QA data gap (G3):** current seed cards are tiny (`fmv` ≈ $8–$40) and mock cards top out at $999, so a real spin only ever lands tiers 1–2 (gray / light-blue) — tiers 3–6 **never fire** on existing data. The 6-tier glow is the reveal's centerpiece, so **seed a handful of high-value fixture cards** (one per tier, ≥$10k for `immortal`) or add a dev value-override, else Playwright cannot verify the upper tiers.
- **Thresholds** are confirmed defaults (operator-tunable later); the bands above stand.

## 4. Reported bugs (folded in)

1. **Win shown mid-spin** → win label/sound/price + the grow-glow fire only on the reel's **settle**, never during the scroll. By construction.
2. **Layout shift / footer expansion** → `/slots/[slug]` is a **fixed immersive full-screen** surface (no site header/footer, no scroll), controls in fixed positions, nothing reflows mid-spin.

## 5. Routes

| Route           | Role                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/slots`        | **Configurator — a lean dedicated page** (`/slots/page.tsx` server + `SlotsConfigClient` client, mirroring the `marketplace/` server→client split). Lists slot-eligible packs as tiles + a **quantity stepper (1–3)** + Play → `/slots/[slug]?count=N`. **Reuses `PackDetailClient`'s data source and shared visual primitives, but is NOT a fork of that claw-coupled component** (G1). |
| `/slots/[slug]` | **Immersive full-screen reveal**: N front-facing packs → tap → peel → N vertical Pokémon reels → stop staggered L→R → grow+glow winner. No site chrome. `count` via query.                                        |

`/claw/*` untouched. **Configurator decision (G1):** build a lean dedicated `/slots` configurator rather than forking or over-parameterizing `PackDetailClient` (it is tightly coupled to the claw stage/carousel/details/recent-pulls, has a single-open CTA, and no quantity selector — "just reuse it" is heavier than it reads). Reuse the *data loader* and *shared primitives* (pack tile, quantity stepper, the `openPack`/`open-batch` actions) — keep the claw component untouched to avoid regressing `/claw`. (Mirrors the pre-pivot `SlotsConfigClient` from commit `222e5c3`, but written fresh against current pack-data shapes.)

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

**Chrome-suppression mechanism (G2 — route groups).** `SiteHeader`/`SiteFooter` currently live in the **root** `layout.tsx`, which wraps every route — a nested layout *composes* with it and cannot remove it. Resolution: relocate the chrome into a `(site)` route-group layout and move the currently-chromed routes under `src/app/(site)/`; place the immersive slot reveal in a bare `(immersive)` group (or leave it at root once root holds only `<html>`/providers). Route groups don't change URLs, so this is a mechanical folder move. **This restructure lands in Phase B** (when the full-screen surface is built), not Phase A′.

> **Rev 4 (Phase B, 2026-06-19) — SUPERSEDES the route-group plan above.** Phase B suppresses chrome with a **fixed `inset-0 z-[100]` overlay + a `useChromeInert` hook** that marks every `[data-site-chrome]` element (SiteHeader/SiteFooter) `inert` + `aria-hidden` and locks body scroll while the immersive route is mounted. Chosen over the ~25-folder route-group move for blast radius (modal-grade focus isolation, no folder restructure). The route-group option remains available if a later phase needs true multi-root isolation. Verified on the prod standalone (:4000) by `scripts/qa-slots-phaseB.mjs`.

## 11. Reuse map

| Reuse                                                                             | For                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `PackDetailClient` data loader + shared primitives (`/claw/[slug]`)               | the lean `/slots` configurator — reuse the data source + pack-tile/quantity primitives only, **do not fork the component** (G1) |
| `@/lib/mock/pokedex` (`spriteGif`/`spritePng`/`POKEDEX_NAMES`/`getGeneration`)    | reel Pokémon sprites + card→Pokémon lookup            |
| `RouletteClient`'s `Thumb`/`<img>` sprite pattern (`PokeSprite` in PokedexClient) | reel cell rendering with gif→png fallback             |
| `reelTarget`/`buildStrip` (`src/lib/reel.ts`)                                     | reel landing math — `reelTarget` is **X-axis**; add a `reelTargetY` (`itemH`/`translateY`) variant. `buildStrip` pins a winner in a **`Rarity[]`** strip; v2 cells are **dex/sprites** w/ random-dex decoys, so reuse the *winner-pinning structure* but write a dex-strip builder, don't reuse it verbatim (G6). |
| `SellBackPanel`, `useSound`, `motion.ts` tokens, win-burst keyframes              | sell-back, SFX, peel + grow/glow polish               |
| `openPack`/`revealPull`/`getCreditBalance`/`sellBackPull` + new `openBatch`       | rolls + sell-back                                     |

## 12. Removed (superseded ball work)

The first Phase-A pass built a ball direction that is now wrong. **Remove**: `src/app/slots/[slug]/BallToken.tsx` (revert to v1 or delete if the v2 reel replaces it), `src/lib/balls.ts`, `src/lib/ball-alpha.ts` (+ tests), `scripts/process-balls.mjs`, `public/images/balls/*`. (Single "remove superseded ball assets" commit.) The flood-fill helper has no remaining consumer.

## 13. Testing

- **Unit (vitest):** `pokemonFromCard(name)` (parse Pokémon → dex), `priceTier(value)` (6-tier buckets + boundaries), vertical reel math (`reelTargetY`), `buildStrip` (reused), `open-batch` shaping.
- **Backend integration (jest):** `open-batch` all-or-nothing (1 debit + N pulls / whole-batch reject + rollback; lock per roll; cap 3).
- **Playwright (prod build :4000):** configurator → Play → packs → tap → SPIN → reels land staggered → grow+glow only after stop → COST debits N×price → sell-back → view-card; reduced-motion; full-screen no-layout-shift; win-rate-lock regression.

## 14. Phased rollout (revised)

- **Phase A′ — Configurator + reel-token swap:** ball work is **already removed** (verified clean — branch net-diff vs master is just this spec + `.gitignore`). Build the **lean dedicated `/slots` configurator** (G1; `/slots` index is net-new — v1 only shipped `/slots/[slug]`, G7) routing to `/slots/[slug]?count=N`; build `PokemonToken` (sprite via `spriteGif` + png fallback per `PokeSprite` + grow/glow by tier) + `pokemonFromCard` (normalized longest-match + null fallback, §2) + `priceTier` (§3) — both helpers TDD.
- **Phase B — Full-screen reveal + vertical Pokémon reel:** ✅ **DONE 2026-06-19** (branch `worktree-slot-v2-phaseB`). immersive route via fixed-overlay + `useChromeInert` (NOT route groups — see §10 rev 4); `reelTargetY` + `buildDexStrip` (TDD); `SlotReelColumn`/`SlotReelStack` (N-capable, driven at count=1 — single `openPack`; N-roll wiring is Phase D); shared horizontal payline; winner grow+glow on settle. Win-after-stop guaranteed: settle gates on the strip's OWN `transform` transitionend (a bubbled child `scale` transitionend was firing the win mid-scroll — fixed) + the win flow reads from a `pending` ref applied only on `onAllSettled`. Dead v1 ball reel (`SlotReelRow`/`BallToken`/`PaylineBeam`) removed. Verified on :4000 by `scripts/qa-slots-phaseB.mjs`.
- **Phase C — Packs + peel:** N front-facing packs (pack foil art); one-tap peel (`PackPeel`, Motion + CSS clip-path, swappable); idle→SPIN gate.
- **Phase D — `open-batch` backend** (all-or-nothing) + `openBatch` action; wire N reels to N rolls.
- **Phase E — Sell-back + view-card + polish:** focused-column sell-back, view-card modal, SFX, big-win burst, reduced-motion, a11y, Playwright sign-off.

## 15. Open items (confirm)

1. ~~Price-tier thresholds~~ — **confirmed** (defaults in §3 stand, operator-tunable later). Open instead: seed/override high-value cards so tiers 3–6 are QA-verifiable (§3 G3).
2. Decoy sprite pool size/range per reel (default: random across all dex, reshuffled per spin).
3. Pack-peel choreography (Phase C visual tune).
4. Whether `/slots` keeps the demo spin (default: yes).
5. Non-Pokémon-card fallback visual — default = card thumbnail + tier glow (§2); confirm if a dedicated card-back asset is preferred.

---

**Animation engine:** Motion (`motion/react`, installed) + CSS `clip-path` peel + CSS-transform vertical reel; `motion-framer` skill installed; peel as a swappable component (Rive/Lottie later). Research (find-skills + last30days): Remotion/Hyperframes are video engines (excluded); Rive/Lottie are designer-authored (deferred).
