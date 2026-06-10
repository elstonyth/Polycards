# Live phygitals.com — QA Exploration & Gap Report

**Date:** 2026-06-09 · **Method:** live exploration of phygitals.com (Playwright MCP, standalone Chromium) cross-referenced with `AUDIT_PUNCHLIST.md`, `components/pack-opening.spec.md`, the `openpack-live/` live-demo capture frames, and **direct reads of every clone route's source** (the route classifications below are verified against the files, not inferred from names).

> **Target authenticity verified first.** The browser hit the *real* production site, not our clone — confirmed by the network/console stack (`api.phygitals.com`, `privy.phygitals.com` embedded-wallet auth, `h.phygitals.com` PostHog, Cloudflare **Turnstile** bot-challenge, Verisoul, TalkJS, WalletConnect, a Vercel `dpl_…` deploy id) and a clean hosts file. The Medusa-style slug `starter-pack-q4pux3` is genuinely the live handle — the clone copied it.

> **False positives avoided:** (a) a cold homepage snapshot appears to lack "Our Community" / "Weekly Leaderboard" — those are below-the-fold, client-rendered, and just hadn't hydrated; the clone has both. (b) the original itself 404s a few assets (`/noise.png`, `/circuit-board.svg`, `elite-pack-0-icon.webp`). Neither reported as a clone fault.

> **Correction note (important for trust):** an automated route-inventory first pass labeled ~16 routes "STUB"; on direct file inspection **that was wrong** — those routes are built (mock-backed). The corrected picture is in §3. This report's claims were re-verified against source before finalizing.

---

## 1. Opening-pack animation — ✅ BUILT & frame-matched (NOT missing)

The clone's pack-opening reveal is **already implemented and frame-matched to live** in `src/app/claw/[slug]/PackOpenOverlay.tsx` — a full-screen 5-stage state machine. Confirmed firsthand from the live demo capture (`openpack-live/`):

| Stage | Live (observed firsthand) | Clone |
|---|---|---|
| **1 · Carousel** | Real 3D **cylinder** of 6 packs 60° apart (gold/black "POKEMON LEGEND", Pokéball, embossed "P"), floor reflections, back-arrow + ⚡/🔊, "⇄ SHUFFLE", "TAP TO SELECT A PACK TO OPEN". Drag rotates, snaps to nearest 60°. | Matched (imperative drag, snap, shuffle, tap-to-select). |
| **2 · Slab** | Face-down PSA holder: "phygitals" wordmark + QR, embossed "P" + category glyphs, "PHYGITAL CERTIFICATION", "● TAP TO REVEAL". | Matched (rebranded "pokenic"). |
| **3 · Metadata** | Staggered glow fade-in: `YEAR 2003 · CATEGORY Pokemon · GRADE PSA 10 · MYTHIC`, ~1.8s. | Matched (YEAR omitted unless present; grade parsed from card name). |
| **4 · Pull** | Diagonal **gold rarity ribbon** "MYTHIC PULL •" + white "MYTHIC!" shout over the slab, ~1.15s. | Matched (ribbon color from RARITY_RGB). |
| **5 · Card reveal** | Won card in PSA holder ("2003 Pokémon EX Sandstorm Holo … PSA 10 GEM MINT"), rarity glow, "1 of 1 · MYTHIC · $2,606.69", green **Continue** + **Open another**. | Matched. |

- **Trigger:** live **"Try a free demo spin" runs the identical animation with no login** (how it was captured). Real opens are auth-gated.
- **Backend:** clone real open → `openPack(slug)` server action → `POST /store/packs/{slug}/open` → returns the real pulled card through the same overlay; demo uses a random `CARD_POOL` card. Reduced-motion jumps to the card stage.
- **Polish gaps (not "missing"):** no **sound** (⚡/🔊 inert) and no **confetti/particles** (the ribbon does match live); demo pulls use placeholder `CARD_POOL` art; the detail-page claw-machine demo spin is a CS:GO-style roulette strip whose exact live grab/drop was never frame-matched; live-odds table is a static mock (intentionally decoupled from secret backend odds).

---

## 2. What's genuinely MISSING vs live

Narrow list — the clone is far more complete than expected (see §3), so these are specific deltas, not whole pages.

### 🟠 MEDIUM — `/claw` per-card quantity stepper + inline Open
Today's live `/claw` shows a **`− 1 + MAX` stepper and inline `Open` button on every pack card** (set quantity and open straight from the list). The clone **deliberately omits it** — `ClawClient.tsx:15`: *"No quantity stepper (live /claw has none — unlike /repacks)."* That assumption is contradicted by the current live DOM (live likely re-added it since the 2026-06-07 audit, whose capture was viewport-limited). Net: the clone forces a detail-page trip to open; live doesn't. **Verified both sides.**

### 🟡 LOW / known
- **Checkout / payment modal** — live "Open Pack" opens a **"Buy a pack"** checkout (Credit Card / Wallet, USDC / USDT, order summary, points, "Preparing secure checkout…"). The clone opens directly. **Intentional** — payment is out of scope for the backend.
- **Dragon Ball category** — present as a live chip (with Soccer); not a section in today's listing (empty/seasonal). Clone lacks the Dragon Ball chip.
- **Buyback % drift** — live badges read **+90% / +92% Buyback Boost**; the clone still shows **85%** in places.
- **/claw catalog deltas** (already logged): 3 out-of-stock Pokémon tiers (Trainer $10 / Sealed $100 / Base Set $500) with no out-of-stock tile state; baseball Platinum/Mythic tiers; live scrolls each category row as a **horizontal carousel** vs the clone's wrapped grid.

---

## 3. UI completeness — the clone has ~NO bare stubs (corrected)

Verified by reading the source of every route. The clone renders a **complete, designed page on every route** — including the entire live "More ▾" menu (`/activity`, `/pokemon/generation/[gen]`, `/series`) and all `(account)/*` pages. The real axis of "incompleteness" is **data wiring (mock vs live backend), not missing UI** — the mock pages carry an explicit `<DemoNote/>` / "Demo …" disclaimer.

**A) Built + live-backend-wired (real data):**
`/`, `/about`, `/how-it-works`, `/contact`, `/claw`, `/claw/[slug]`, `/leaderboard`, `/marketplace`, `/orders`, `/card/[id]` (backend + mock fallback).

**B) Built + mock/demo data (UI complete, backend wiring pending — shows a "Demo" note):**
`/activity` (txn table), `/series` (set tiles), `/pokemon/generation/[gen]` (Pokédex), `/30th`, `/achievements`, `/airdrop`, `/clawmaker`, `/free`, `/lucky-draw`, `/pack-party`, `/repacks`, `/social`, `/roulette`, `/profile/[user]`, `/launchpad/[brand]`, and `(account)/*` (`/settings`, `/messages`, `/earnings`, `/referrals`, `/pokecoin`, `/nbacoin`, `/accelerate-claim`).

**C) Auth-wall / empty-state by design (matches live anonymous view):**
`/fairness` ("Failed to load proofs"), `/vouchers` ("No Active Vouchers"), `/bank-withdrawal` (sign-in wall). (`/settings` shows the shell where live shows a sign-in wall — minor over-display.)

> So "UI incomplete" ≈ **0 missing pages**. The follow-up work is backend data wiring on bucket B, not building screens.

---

## 4. The over-build question (verify before investing)

Several built routes are **not in the live primary or secondary nav and were never diffed against live**:
`/roulette`, `/lucky-draw`, `/clawmaker`, `/airdrop`, `/free`, `/launchpad/[brand]`, `/social`, `/30th`, `/nbacoin`, `/pokecoin`, `/referrals`, `/accelerate-claim`.

These may be reachable-by-URL live features, or clone-invented surfaces. **Recommend confirming live existence before further investment** — building/wiring a route the original doesn't have is wasted effort. Precedent: `/store`, `/submitcards`, `/login`, `/signup` were removed for exactly this reason (live 404/500 or modal-only).

---

## 5. NOT gaps (verified faithful or intentional — do not chase)
- Homepage "How It Works" = the clone's **3 steps** (the "4-step" HANDOFF claim was debunked vs live).
- The 6 **sports-pack claw machines** are static (live has no animated AVIF source — 404s `<slug>-1.avif`); the clone's static `.webp` is the faithful match.
- `/fairness`, `/vouchers`, `/bank-withdrawal` auth walls / empty states match the live anonymous view.

---

## Recommended priority order
1. **Restore the `/claw` per-card stepper + inline Open** to match current live; delete the stale assumption at `ClawClient.tsx:15`.
2. **Reconcile catalog/copy drift** — buyback 85→90/92%, Dragon Ball chip, out-of-stock tiles, per-category horizontal carousel.
3. **Backend-wire the bucket-B demo pages** (data, not UI) — prioritize the live-nav trio (`/activity`, `/pokemon/generation`, `/series`) since they're the most-reachable.
4. **Triage the over-built routes** (§4) — verify live existence, then wire or remove.
5. **Pack-opening polish (optional)** — sound + real demo card art; the core animation already matches live.
