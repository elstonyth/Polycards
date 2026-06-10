# Clone vs Live Audit — Punch List (RESOLVED 2026-06-07)

**Status:** ✅ Every *identified* issue from the diffed pass (1 BLOCKER + 4 MAJOR + 7 MINOR + 3 broken-route decisions + 2 animations) is dispositioned — fixed-and-verified, proven STALE against live, or removed per user decision. See the Progress log at the bottom for the per-item outcome. Build green throughout; each fix verified with `npm run build` + Playwright screenshots vs the live reference.
**⚠️ NOT a full-site sign-off:** the ~16 routes in the "NOT YET DIFFED" section below were **never diffed against live** and remain out of this session's scope. Original triage note retained below for history.
**Method:** static screenshot diff (clone :4000 vs live phygitals) at 390 / 1440 / 3840. Animations NOT covered (need filming pass).
**Date:** 2026-06-07

> ⚠️ Capture limitation: live desktop (1440) shots came back **viewport-only** for many routes (the phygitals SPA's full-page capture cut off), so **below-the-fold live sections could not be compared** — clone below-fold was judged on internal quality only. This is why the homepage "How It Works" content mismatch (below) was NOT caught by the static pass.

---

## BLOCKER / MAJOR — wrong page or major IA mismatch (rebuild-level)

1. **/repacks — BLOCKER.** Clone shows a generic "Community Repacks" small-card grid. Live leads with a **hero banner** ("Packs created by anyone / Curated pulls with 85% guaranteed buyback", "Create a Claw" CTA, large hero image) + a **horizontal featured row** of big pack cards (50/50, FIRE, PIKA PACK). Wrong layout AND content.
2. **/claw — MAJOR.** Clone groups packs under **sport-section headers** (Pokemon Packs, One Piece Packs, …) with a **qty stepper (− 1 +)** per card. Live is a **flat filterable list** with a category chip rail (All / PKMN / OP / NBA / MLB / NFL / YGO), **buyback badges**, and **no stepper**. Mobile: clone 2-col cards vs live 1-col list rows.
3. **/fairness — MAJOR.** Clone fabricates ~12 "Verified Proof #N" cards. Live shows "Your Fairness Proofs" → **"Failed to load proofs"** (auth/data wall). Clone invents data live doesn't expose.
4. **/achievements — MAJOR.** Clone = static **8-badge grid**. Live = **"Achievement System"**: 31 achievements / 42,050 XP stats, 5 rarity-tier cards, sortable "All Achievements" data table. Different concept entirely.
5. **/borrow-lend — MAJOR.** Clone = summary stat cards + loan table (self-labeled "Demo only"). Live = **Create-lend-offer CTA, lend/borrow mode tiles, collection/APR filters, "48 active offers" list** with APR badges + Lend buttons.

## MINOR — close, fixable polish

- **/ (home).** Hero art smaller / corner-pushed vs live's prominent centered-right pack render; clone flat bg vs live magenta/dark **gradient glow**.
- **/pack-party (MINOR–MAJOR).** Missing **blurred pack-art banner** behind the header; clone adds "Join Party" buttons live doesn't show; mobile 2-col vs live 1-col.
- **/marketplace.** Clone cards are **slab-framed (PSA-holder)** vs live **raw card art**; clone adds a left filter sidebar live lacks at 1440; clone mobile missing live's floating cart/scroll buttons.
- **/merchants.** Clone **compact left-aligned hero** vs live **large centered hero** w/ whitespace; merchant data rebranded (fictional names) vs live's real merchants.
- **/about (MINOR–MAJOR).** Missing **"Powering 100K+ collectibles" pill** above headline; hero CTAs differ (clone header-nav vs live **"Explore Packs / Launch With Us"** hero buttons).
- **/vouchers.** Live shows an empty-state (anon); clone shows richer mock data — layout concept differs (clone sidebar vs live centered hero).
- **/bank-withdrawal.** Header wording "Withdraw to bank" vs live "Bank Withdrawal"; live is auth-gated (sign-in wall).

## OK — faithful / good match

- **/how-it-works** — best match (only hero background glow differs). *(NB: this is the standalone route page; the HOMEPAGE HIW section is a separate problem — see Animations/Known.)*
- **/leaderboard** — closest match; podium empty-bars are faithful to live (live quirk).
- **/settings** — clone-only (live = "Sign in to manage your settings" wall); clone account-shell complete.
- **/activity** — clone complete; live shot viewport-only limited the compare.

## Live route is BROKEN / nonexistent — clone cannot match ✅ RESOLVED (removed)

- **/store → live 500.** ✅ Removed (clone route deleted → 404).
- **/submitcards → live 500.** ✅ Removed (route deleted; sidebar entry removed).
- **/login, /signup → live 404** (phygitals uses modals). ✅ Removed; replaced with a global `AuthModal` opened from the header + marketing CTAs.

## NOT YET DIFFED (~16 routes — paused at cost cap)

/contact · /series · /30th · /free · /lucky-draw · /roulette · /clawmaker · /airdrop · /social · /orders · /messages · /earnings · /referrals · /pokecoin · /nbacoin · /accelerate-claim · /pokemon/generation/1

## Animations — separate frame-by-frame filming pass (NOT in static diff)

1. **Homepage "How It Works"** — ✅ **NO FIX NEEDED — the "4-step" claim is DEBUNKED.** Verified directly against live (2026-06-07, Playwright `innerText` probe of phygitals.com with `reducedMotion` + scroll-container expansion): the live homepage HIW is **exactly the clone's 3 steps** — "Open a pack" / "Reveal your card" / "Keep, ship, or sell…" (all present), plus "provably fair", "redeem", and the "85-90% Instant Buyback" explainer modal. The alleged 4-step version ("Find the perfect pack / Buy with confidence [Popular] / Buy and sell instantly / Make money / Works fun and simple") returned **0 matches** on live — it was an outdated HANDOFF claim (see memory `phygitals-live-review-technique`). The **entry animation already exists** (`HowItWorksSteps` fade-up + stagger via `useInView`, reduced-motion honored). ⚠️ HANDOFF.md still carries the stale 4-step copy — do not chase it.
2. **/claw "try a free demo spin"** — ✅ **VERIFIED WORKING (already implemented).** Lives on the claw **detail** page (`/claw/[slug]/PackDetailClient.tsx`), not the list. Click-triggered: the `spin()` handler runs a 4.2s eased roulette-strip reveal that lands on a winner and shows "You pulled {card}", and the iridescent rebranded claw-machine AVIF renders above it. Reduced-motion → instant result. Driven + captured via Playwright (`_spin/04-revealed-full.png`); machine `.avif`/`.webp` both 200. NOTE: the clone uses a CS:GO-style roulette reveal; the live animation's exact grab/drop style was **not frame-matched** (would need a live click-through filming pass) — deferred as a fidelity nicety, the clone's spin is complete + reduced-motion-aware.

## Severity tally (of ~18 diffed)
1 BLOCKER (repacks) · 4 MAJOR (claw, fairness, achievements, borrow-lend) · 7 MINOR · ~4 OK · 3 live-broken (store, submitcards 500; login/signup 404)

---

## Progress (2026-06-07)
- ✅ **/repacks FIXED & VERIFIED** — rebuilt as a single-file client page: blurred pack-art **hero banner** ("Packs created by anyone" + 85% buyback subtitle + "Create a Claw" CTA + featured pack render), category **chip rail** + Filters/sort toolbar, and a grid of **big pack cards** (2-col mobile → 5-col desktop) each with a **qty stepper (− 1 + MAX)** + Open button + +85% buyback badge + creator attribution. `npm run build` green; screenshots `audit/shots/repacks/clone-{390,1440}.png` match the live hero+featured-row IA (1440) and card internals (390). NOTE: this is a **layout** fix — pack ART is reused from /claw with community-flavored names/creators; the live 50/50 / FIRE / PIKA custom artwork is user-uploaded and not reproduced 1:1.
- ✅ **/claw FIXED & VERIFIED** — ⚠️ **the punch list's "live is a flat list, no section headers" call was WRONG** (auditor misread — the viewport-only capture limitation). The live `live-{390,1440}.png` clearly show per-category **section headers** ("Pokémon Packs / 5 packs", "One Piece Packs", …). Corrected to match live: restored per-category sections (heading + pack count + icon), kept the stepper removed (live /claw genuinely has none), added category icons to the chip rail + a "Creator Packs" toggle, and rebuilt **mobile as 1-col list rows** (thumb | name + buyback badge | price pill) instead of 2-col cards. Desktop = card grid per section. `npm run build` green; screenshots match live at 390 + 1440.
- ✅ **/fairness FIXED & VERIFIED** — stopped fabricating ~12 "Verified Proof #N" cards. Now matches the live anonymous view: "Your Fairness Proofs" heading + the commit-reveal explainer (serverSeedHash/serverSeed/clientSeed) + a red **"Failed to load proofs"** data wall (proofs are per-account, auth-gated). `src/app/fairness/page.tsx` (server component).
- ✅ **/achievements FIXED & VERIFIED** — replaced the static 8-badge grid with the live **"Achievement System"**: centered trophy hero + stat pills (**31 Achievements / 42,050 Total XP**, both derived from the data so they stay consistent), **5 color-coded rarity-tier cards** (Common→Legendary), and a **sortable "All Achievements" table** (Achievement | Category | Rarity | XP Reward | Status — all Locked, matching the anonymous view; Rarity/XP columns hidden on mobile). **Moved out of the `(account)` route group → standalone full-width route** (live has NO account sidebar). `src/app/achievements/page.tsx` (client, sortable).
- ✅ **/borrow-lend FIXED & VERIFIED** — replaced the summary-stats + loan-table demo with the live peer-lending marketplace: "Borrow / Lend" header + **Create lend offer** CTA, two **mode tiles** (lend USD / borrow USDC), a **collections + APR-sort filter row** with **"48 active offers"** count, and a list of **48 lend offers** (thumb | card + lender + expiry | amount + APR%/duration | Lend). APR sort is live; collections select is presentational. **Moved out of `(account)` → standalone route** (no sidebar). `src/app/borrow-lend/page.tsx` (client).
- ✅ **Live-broken routes REMOVED (user decision: "remove to match live")** — deleted `/store`, `/submitcards`, `/login`, `/signup` (all now 404, matching live). Login/Signup are now a **modal** (live uses a modal, not pages): new `AuthModal` (portal, Esc/backdrop close, scroll-lock) + `AuthButton`/`openAuth` (window-event trigger); `AuthForm` refactored to modal content with in-place login↔signup toggle. Wired the SiteHeader Login/Sign Up buttons + the /airdrop and /free signup CTAs to open it; removed "Submit Cards" from `AccountSidebar`. Build green; verified 404s + modal open/toggle via Playwright click.
- ✅ **MINORs DONE & VERIFIED (read each live-*.png first — several punch-list claims were STALE):**
  - **/about** — added "● Powering 100K+ collectibles" pill + "Explore Packs"/"Launch With Us" hero CTAs (replaced the in-hero logo strip; logos still in the Vault section). #launch anchor added.
  - **/merchants** — rebuilt: centered hero (Global Network pill + search) + centered chips + **real merchants** (Cardmarket EU, Card Kingdom, TCGPlayer, Troll and Toad, CoolStuffInc, 401 Games, Dave & Adam's, Blowout Cards, Magic Madhouse) with rating + region + shipping badges.
  - **/vouchers** — rebuilt as standalone (moved out of `(account)`): centered "Your Vouchers" hero + "No Active Vouchers" empty state (no fabricated vouchers).
  - **/bank-withdrawal** — rebuilt as standalone: "Bank Withdrawal" heading + amber "Sign in to withdraw to your bank." auth wall + "Log in to continue" (opens AuthModal). Fixed wording ("Withdraw to bank" → "Bank Withdrawal").
  - **/marketplace** — removed the persistent left filter sidebar (live has none at 1440); the toolbar "Filters" button now opens it as a left drawer on all breakpoints; grid is full-width. (Slab-vs-raw card art + mobile floating cart/scroll buttons NOT changed — low-confidence claims; card images are sourced from live.)
  - **/ (home)** — ⚠️ **claim STALE, no change.** Clone hero already has the live's blurred+saturated per-pack glow (NOT a flat gradient) and the right-positioned carousel render (measured `HeroSection`). Verified clone-1440 vs live-1440.
  - **/pack-party** — ⚠️ **claims STALE, no change.** Live `live-{390,1440}.png` confirm the clone already matches: blurred pack-art banner present (both), "Join Party"/"Great Deal" cards present on live, and mobile is **2-col on live too** (not 1-col).
- ✅ **/claw "try a free demo spin" VERIFIED** — already implemented on the detail page; click-driven roulette reveal + claw-machine AVIF, reduced-motion aware. (See Animations §2.)
- 🎉 **All IDENTIFIED fixes resolved** (BLOCKER + 4 MAJOR + 5 real MINOR fixed & verified at 1440 + 390; 2 MINOR + the HIW "4-step" + several pack-party/claw claims were STALE and dispositioned against live; broken routes removed per user). Honest carve-outs: (a) **~16 routes never diffed** (NOT YET DIFFED section) — out of scope; (b) marketplace slab-vs-raw + mobile float buttons (low-confidence, untouched); (c) claw demo-spin exact-style frame-match (deferred). The marketplace Filters **drawer was driven via Playwright** (opens on Filters click → left panel over backdrop; closes on backdrop click) — verified working, not just inspected.
- ⚠️ **Session note:** this session hit cost-critical ($70+); sub-agents now auto-halt on the cost flag and the main context is large (high per-turn cost). **Continue remaining fixes in a FRESH session** pointed at this file — far cheaper per turn, and a fresh sub-agent won't inherit the cost-stop.

---

## Progress (2026-06-08) — /claw Pokémon catalog (verify-first)

**Verified the "8 tiers + Dragon Ball" content claim against the LIVE catalog** (fetched
`phygitals.com/claw` `__NEXT_DATA__.props.pageProps.initialPacks`, 37 packs). Findings:

- **Live Pokémon = 10 tiers** (authoritative, with real prices): Trainer $10 (oos), Rookie $25,
  Elite $50, Sealed $100 (oos), Legend $250, Platinum $500, Base Set $500 (oos), Mythic $1,000,
  **Black $2,500**, **Diamond $5,000**. Clone had **5** (Mythic/Legend/Elite/Platinum/Rookie).
- ✅ **ADDED & VERIFIED: Black Pack ($2,500) + Diamond Pack ($5,000)** — the two confirmed
  in-stock, visible-on-live premium tiers the clone lacked (lead the live row in
  `design-references/phygitals-open/02-claw.png`). Downloaded brand-clean icons
  (`black-pack-icon.webp`, `diamond-pack-icon.webp`) → `packs-data.ts` pokemon array, premium-first.
  `clawMachine()` now falls back to the pack icon for bases in `CLAW_NO_MACHINE`
  (black-pack/diamond-pack) so their detail pages render the brand-consistent icon instead of a
  broken/phygitals-branded machine. `npm run build` green; `scripts/verify-pokemon-packs.mjs` →
  PASS (7 tiles, 0 broken imgs on list + both new detail pages, 0 overflow, mock pools degrade OK).
  Pokémon section count auto-updated to "7 packs".
- ⏸️ **DEFERRED (out-of-scope this pass):**
  - **3 out-of-stock pokemon tiers** (Trainer $10, Sealed $100, Base Set $500) — `in_stock:false`
    on live and not confirmed visible in captures; needs an out-of-stock tile state to add faithfully.
  - **Branded claw-machine avifs** for black/diamond (`/images/claw/<base>-1.avif` downloadable but
    carry full phygitals banner/placard/url) — belong with the claw-rebrand task (join
    `black-pack-jjnfuk` in the pending machine-rebrand queue). Detail page uses icon fallback meanwhile.
  - **Grid → horizontal-carousel layout** per category (live scrolls each row with a `>`; clone wraps).
    Real but lower-impact; bundle with the rebrand/layout pass.
- ⚠️ **STALE-ish:** no "Dragon Ball" SECTION renders in any live capture (live categories =
  Pokémon/One Piece/Basketball/Baseball/Football/Soccer/Yu-Gi-Oh/Riftbound, which the clone already
  matches) — BUT a `pack index icons/dragonball.webp` asset *does* exist on live, so it may be a
  category with no in-stock packs. Not fabricated.
- Note: live catalog is **seasonal/rotating** (prices + stock shift); the clone is a faithful
  snapshot, so chasing exact rotating membership beyond the visible premium tiers isn't the goal.
- ✅ **PACK-OPENING ANIMATION fully rebuilt & frame-matched (interactive)** — re-measured the LIVE
  demo (recon-live-openpack{,2}.mjs + recon-live-reveal.mjs → `docs/research/openpack-live/`) and
  rebuilt `PackOpenOverlay.tsx` to match its **5 stages**: (1) an **interactive 3D pack cylinder**
  (6 packs 60° apart, r≈188, **drag/swipe to spin**, snap-to-slot, Shuffle, tap-to-select),
  (2) face-down **graded slab**, (3) **metadata** (Category/Grade/Value + rarity, glow + stagger;
  GRADE parsed from card name, YEAR omitted — not in clone data), (4) the **rarity "PULL"
  celebration** (diagonal rarity-colored marquee ribbon + "<Rarity>!" shout — a stage the clone
  previously lacked), (5) the won card in a **PSA-style graded holder** (top label + grade badge +
  rarity glow) → name + rarity + value + Continue/Open another. **Backend connection unchanged**:
  `handleOpenPack()` → `openPack()` server action reveals the REAL pulled card through the same
  overlay (demo uses a random pool card). `npm run build` green; `scripts/capture-pack-open-anim.mjs`
  → 9/9 PASS; all 5 stages visually confirmed vs live frames. Spec: `components/pack-opening.spec.md`.
- ✅ **Pack-opening cylinder drag LAG fixed** — was calling `setRotation` on every pointermove (re-rendered
  all 12 pack imgs/frame). Now driven **imperatively**: pointermove writes `cylRef.current.style.transform`
  directly (+`will-change:transform`), React state only on snap/tap. Build green; drag+tap+snap re-verified.

### ✅ RESOLVED: animated claw-machine rebake (verified 2026-06-09)
**Every animation rebake that is POSSIBLE is done.** 18 machines that have a live animated source
(`https://www.phygitals.com/images/claw/<base>-1.avif`, HTTP 200) are rebranded, baked to `<base>-anim.avif`,
and wired into `CLAW_HAS_ANIM` (`packs-data.ts`): the pokemon tiers (incl. black-pack + diamond-pack), all
One Piece + Yu-Gi-Oh tiers, NBA black/legend/platinum (black-pack-jjnfuk, legend-pack-1dpaec,
modern-grails-noafw0), pro-soccer-pack, and starter-riftbound-pack. `CLAW_NO_MACHINE` is now **empty**.
- **The only non-animated machines are the 6 sports packs** (baseball: pro/legend/starter; football:
  elite/starter/platinum). They **CANNOT be animated**: live returns **404 for `<slug>-1.avif`** (only a
  static `<slug>-1.webp` exists), and their live `__NEXT_DATA__` records have `claw_image_url: null` with the
  *same data shape* as animated packs — the live frontend builds the machine URL purely by slug convention,
  so there is no animated source to download. The clone's static `<base>-machine.webp` fallback is therefore
  the **faithful match to live**. Nothing to rebake. (Verified via direct AVIF probe + live record diff:
  `pro-baseball-pack` vs animated `legend-pack` — identical keys, `claw_image_url` null on both.)
- **Separate items (NOT animation rebakes — do not fold in):** live baseball has 2 packs the clone lacks —
  `platinum-baseball-pack`, `mythic-baseball-pack` (catalog completeness); and live `buyback_percent` reads
  0.85 on pro-baseball vs 0.9 on the premium tiers (the 85→90 copy drift). Track under catalog/copy.
- **Method (for reference, if live ever adds a source):** download `<base>-1.avif` → rebrand banner/placard/url
  frame-by-frame → ffmpeg re-encode (⚠️ kill stale ffmpeg first, cap `-frames:v`, runaway-CPU risk) → bump
  `CLAW_REV` → add base to `CLAW_HAS_ANIM`. See the `claw-rebrand` skill.
- **Open (separate from animation):** the already-animated machines carry a pokenic BANNER but several still
  show a phygitals PLACARD/URL (base-text rebrand = "task 19").

#### Attempt log (2026-06-09) — groundwork done, first bake bounced (verify-first caught it)
- **Pipeline confirmed reusable** (search-first): `make_patch.py` (top-band patch from `<base>-machine.webp`)
  → `rebake_ff.mjs` (overlay onto `<base>-machine.avif` → `<base>-anim.avif`). Toolchain verified:
  ffmpeg 8.1.1 + libsvtav1, venv pillow_avif. Banner rebrand technique = `rebrand-claw-final.mjs`
  (stroke-level inpaint of the wordmark + redraw "Pokenic").
- **DONE:** downloaded live animated sources for black-pack + diamond-pack
  (`black-pack-1.avif`/`-machine.avif`, `diamond-pack-1.avif`/`-machine.avif`); wrote focused
  `scripts/rebrand-banner-new.mjs` (scoped to these 2, won't touch the 16 existing).
- **❌ First rebrand pass DOUBLED the wordmark** (drew "Pokenic" ABOVE an un-erased "phygitals") —
  reverted the bad `<base>-machine.webp` (were never wired; black/diamond stay in CLAW_NO_MACHINE → icon,
  no regression). Two reasons, both the skill's lesson #3 (busy-bg contamination):
  1. On **black-pack the "phygitals" wordmark is ORANGE-glow**, not white — the white-only `isText`
     missed it (so it wasn't erased), and a stray white highlight at y≈134 gave a false position.
  2. Color-threshold measurement of the wordmark y is **contaminated by the glowing machine frame +
     pack** (bbox sprawls y133→299). Raw numbers are not trustworthy here.
- **Corrected approach for next pass (per skill: measure by DRAWING the bbox, then PIN):** (a) extract
  frame 0, save a **zoomed crop of just the banner**, read the true wordmark top/centre by eye off a grid;
  (b) PIN cx/cy + a tight inpaint band (don't rely on color detection); (c) on black, detect+erase the
  ORANGE wordmark and **redraw "Pokenic" in matching orange-glow** (white won't match); (d) verify the
  STILL before `make_patch`+`rebake_ff`, then anim frame 0, then live :4000.
- **One Piece correction (was wrong above):** the One Piece `<base>-machine.webp` stills are **NOT
  rebranded** — top banner = tier name ("LEGEND PACK MACHINE", no wordmark); brand is in the LOWER zone
  ("Phygitals.com" + "RIP & REVEAL by phygitals"). So One Piece needs the **lower-zone** rebrand
  (`rebrand_bottom.mjs` / placard-url style), NOT the top-band banner patch. Re-scope before doing them.

### Other STILL-OPEN /claw items (user said they'll handle these)
- Live `/claw` list uses a **horizontal-scroll carousel** per category; clone uses a wrapped grid.
- 3 out-of-stock Pokémon tiers not added (Trainer $10, Sealed $100, Base Set $500) — need an out-of-stock tile state.
- **Dragon Ball IS a live category** (confirmed in the live chip rail on 2026-06-08) — clone lacks it.
- Live buyback is now **90%** (clone shows 85% in places).
