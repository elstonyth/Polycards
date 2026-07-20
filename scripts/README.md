# scripts/ — classified inventory (Plan 055, Step 1)

> **STATUS: PROPOSED — deletions pending operator approval.**
> Nothing has been deleted or moved. This file is the Step-1 deliverable of
> plan `055-scripts-dir-triage.md`: a classified inventory of all **269**
> tracked entries under `scripts/`, with a proposed DELETE list and an ASK
> list. The DELETE/move execution (Step 3) happens **only after** an operator
> approves the DELETE list quoted below.

## The rule (why this dir needs a README)

`scripts/` is not shipped, built, or bundled — nothing here is imported by the
app or CI. It is the operator's local UI-measurement / QA / one-off toolbox:

- **Reusable capture/measure/QA tools** and **ops utilities** live here and are
  kept.
- **One-off debug/capture scripts should be born in the gitignored scratchpad**
  (`docs/research/` is the gitignored output dir), **not committed here.** The
  269-file pileup is the accretion of one-offs that never got that memo. When a
  script targets a route that has since been deleted (`/claw`, `/clawmaker`,
  `/marketplace`, `/merchants`, `/pack-party`, `/repacks`, `/series`,
  `/pokemon/generation`), it silently fails or drives a dead route — that is the
  correctness trap this triage removes.

## Method (how each verdict was reached — all grep-verified)

- **KEEP (externally referenced)** — name appears in `package.json`,
  `.github/workflows/*`, `docs/**`, `tests/**`, or `README.md`. This wins over
  every other signal (a referenced script is KEEP even if its route list is
  stale — fixing that is a separate task).
- **KEEP (ops)** — operational utility (`serve-standalone.ps1`-class) or shared
  helper (`lib/pw.mjs`).
- **KEEP (live measurement)** — route scan shows a **live** route/component
  target and **no** deleted-route target; belongs to the measurement workflow.
- **DELETE (proposed)** — route scan shows a **deleted**-route navigation target
  (`page.goto('/claw/...')` etc.) and **no** live-route target, **or** a
  brand-era rebrand one-off (`rebrand-claw-*`, `rebrand-pokemon-*`, `*claw*`).
- **ASK** — anything ambiguous: mixed live+dead route lists, spent iteration
  families with no external ref, and the Python image-processing toolchain.
  **When in doubt, ASK — never DELETE.**

Verdict counts: **KEEP 86 · DELETE 76 (proposed) · ASK 107** (= 269, verified:
every entry appears in exactly one bucket, no duplicates). `ls scripts` counts
`lib/` and `showcase/` as one entry each; their inner files are noted in the
rows below.

## Classified inventory

### KEEP — externally referenced (16)

| File                        | Referenced by                                                | Note                                                                         |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `qa-csp.mjs`                | `package.json` → `qa:csp`                                    | hard keep; its `ROUTES` list still contains `/claw` (stale, prune later)     |
| `qa-a11y.mjs`               | `package.json` → `test:a11y`, `.github/workflows/e2e.yml`    | hard keep; comment references retired `/claw`                                |
| `serve-standalone.ps1`      | `README.md` Quick Start, `tests/e2e/README.md`, e2e workflow | hard keep — prod standalone server                                           |
| `run-e2e.ps1`               | `tests/e2e/README.md`                                        | e2e suite runner                                                             |
| `qa-slot-machine.mjs`       | `docs/superpowers/**` plans/specs                            | live `/slots` regression                                                     |
| `qa-home-redesign.mjs`      | `docs/superpowers/**` plans/specs                            | live `/slots` home QA                                                        |
| `verify-reel-random.mjs`    | `docs/superpowers/**` plan                                   | live `/slots` reel QA                                                        |
| `qa-demo-spin.mjs`          | `docs/superpowers/**` plans/specs                            | **STALE**: targets deleted `/claw` + `/marketplace`; kept because referenced |
| `qa-claw-e2e.mjs`           | `tests/e2e/helpers/storefront.ts` (logic ported verbatim)    | **STALE**: targets deleted `/claw`; logic already lives in tests             |
| `process-slabframe-v2.mjs`  | slab-frame design plan/spec                                  | shipped slab-frame pipeline                                                  |
| `process-slab-frame.mjs`    | slab-frame design spec                                       | **SUPERSEDED** by `-v2`; kept because referenced as background               |
| `gen-slab-frame-module.mjs` | slab-frame plan                                              | generates committed frame module                                             |
| `gen-arimo-font-module.mjs` | slab-frame plan                                              | generates committed font module                                              |
| `measure-slab-margins.mjs`  | slab-frame plan (modified there)                             | slab geometry measurement                                                    |
| `compose-frame-variant.mjs` | slab-frame plan/spec                                         | slab frame composer                                                          |
| `capture-slab-glass.mjs`    | slab-frame plan/spec                                         | slab visual proof                                                            |

> Stale-but-referenced (`qa-demo-spin`, `qa-claw-e2e`, `process-slab-frame`):
> KEEP now; flag for a **future doc/script cleanup** (repoint to `/slots` or
> retire the doc reference), out of scope for this plan.

### KEEP — ops utilities + shared lib (6)

| File                  | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `do-apply.ps1`        | Apply a `.do/*.app.yaml` spec to a DigitalOcean app    |
| `preflight.ps1`       | Prod-parity build/boot against docker-compose.prod.yml |
| `preview.ps1`         | Launch the full dev stack ("run preview")              |
| `db-dump.ps1`         | Snapshot a Polycards Postgres DB to `backups/`         |
| `sync-agent-rules.sh` | Sync agent instruction rules                           |
| `lib/` (`lib/pw.mjs`) | Shared Playwright helper imported by 8+ scripts        |

### KEEP — live-route measurement / QA (64)

Route scan: live-route target present, no deleted-route target. Grouped:

| Family                   | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Target                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Slots / spin QA          | `qa-slots-config`, `qa-slot-sfx`, `qa-slots-phaseB`, `qa-press-spin`, `record-slots-demo`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `/slots`                                   |
| Frame / animation QA     | `qa-frame-animation`, `qa-frame-stress`, `qa-frame-workbook`, `qa-anim`, `capture-slab-frame`, `capture-tier-glows`                                                                                                                                                                                                                                                                                                                                                                                                                           | live components                            |
| Account surfaces         | `qa-vault-room`, `qa-vip-claim`, `qa-withdraw-gate`, `capture-wallet`, `qa-me-redesign`, `verify-account`, `qa-public-profile`                                                                                                                                                                                                                                                                                                                                                                                                                | `/vault` `/vip` `/wallet` `/me` `/profile` |
| Daily / rewards          | `qa-daily-admin-walk`, `qa-daily-box-locks`, `qa-daily-storefront-walk`, `capture-rewards-rework`, `capture-ranks-challenge`                                                                                                                                                                                                                                                                                                                                                                                                                  | `/daily` `/rewards`                        |
| Notifications            | `probe-notifications`, `probe-notifications-history`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `/notifications`                           |
| Admin QA                 | `qa-admin-e2e`, `qa-admin-frames`, `qa-admin-full-sweep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Medusa `/admin`                            |
| Leaderboard / HIW        | `verify-leaderboard-feed`, `qa-both-hiw`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `/leaderboard` `/how-it-works`             |
| Responsive / mobile      | `qa-responsive`, `qa-mobile-cards`, `qa-mobile-reveal`, `qa-mobile-round3`, `qa-pack-detail-mobile`, `final-resp`                                                                                                                                                                                                                                                                                                                                                                                                                             | live routes                                |
| Modals / pills / misc UI | `qa-modal2`, `qa-modal-portal`, `qa-modal-resp`, `qa-pills`, `qa-card-detail`, `qa-display-image`, `qa-idle-drift`, `qa-storefront-appearance`, `qa-appearance-part2`, `qa-phase5`, `qa-final`, `qa-full-route-sweep`, `film-hero-entry`, `verify-hero-stagger`, `verify-roll-shift`, `verify-card-images`, `verify-pages`, `verify-rate-limits`, `measure-meter`, `find-broken`, `shot-4k`, `final-shots`, `qa-forgot-password`, `capture-shell`, `capture-shell-auth`, `capture-tabs-polish`, `capture-odds-sheet`, `capture-images-verify` | live routes/components                     |

### DELETE — proposed (76) — targets a deleted route/entity or brand-era rebrand

**Requires operator approval before any `git rm`.**

Claw-machine era (route `/claw`, `/clawmaker` — deleted plan 024):
`audit_claw.py`, `calibrate-claw.mjs`, `capture-claw.mjs`, `qa-claw-changes.mjs`,
`rebrand_claw.py`, `rebrand_claw_test.py`, `rebrand-claw-bake.mjs`,
`rebrand-claw-dramatic.mjs`, `rebrand-claw-final.mjs`, `verify-claw-4k.mjs`,
`verify-claw-anim.mjs`, `verify-claw-parity.mjs`, `verify-claw-placard.mjs`,
`verify-claw-placard-zoom.mjs`, `verify-claw-stepper.mjs`, `verify-clone-anim.mjs`,
`verify-live-claw.mjs`, `verify-live-full.mjs`, `debug-cyl-drag.mjs`,
`inspect-machines.mjs`, `measure-machine-render.mjs`, `film-clone-motion.mjs`,
`calibrate-dramatic.mjs`, `render-dramatic-grid.mjs`.

Pack-open / sell on the retired `/claw/<pack>` route:
`capture-pack-detail.mjs`, `capture-pack-open.mjs`, `capture-pack-open-anim.mjs`,
`verify-open-auth.mjs`, `verify-open-under-limit.mjs`, `verify-pack-tap-skip.mjs`,
`verify-card-fling.mjs`, `verify-secret-odds.mjs`, `verify-winrate-applies.mjs`,
`verify-bake.mjs`, `verify-nextimage.mjs`, `verify-overlay.mjs`,
`verify-anim-seam.mjs`, `verify-pokemon-packs.mjs`, `verify-premium-live.mjs`,
`verify-admin-management.mjs`, `zoom-baked.mjs`, `zoom-bottom.mjs`,
`zoom-rookie.mjs`, `overlay-test.mjs`, `detect-lines.mjs`, `diag-mg.mjs`,
`probe-icon-text.mjs`, `preview-pc-rework.mjs`, `crop-disk-webp.mjs`,
`crop-guide.mjs`, `hv.mjs`, `rebake_ff.mjs`, `render-align.mjs`,
`render-product-check.mjs`, `render-rookie-compare.mjs`, `shot-stage.mjs`,
`lama_compose.mjs`.

Pokemon-market (`/marketplace` — deleted #219) + brand-era rebrand one-offs:
`pm-banner-live.mjs`, `pm-capture-allbaked.mjs`, `pm-capture-baked.mjs`,
`pm-capture-rebrand.mjs`, `audit-pokemon-branding.mjs`, `rebrand_anim.py`,
`rebrand_bottom.mjs`, `rebrand-black-banner.mjs`, `rebrand-onepiece-yugioh.mjs`,
`rebrand-pokemon-icons.mjs`, `rebrand-premium-banner.mjs`, `compare-banners.mjs`,
`measure-banner.mjs`, `detect-white-banner.mjs`, `render-all-banners.mjs`,
`render-banner-crops.mjs`, `render-orig-banners.mjs`, `render-orig-2.mjs`,
`render-onepiece-orig.mjs`.

### ASK — operator decision needed (107)

Grouped; one question per family. **None are provably dead — do not delete
without a yes.**

| Family (count)                                 | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Question                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hover-*` iterations (8)                       | `hover-audit`, `hover-audit2`, `hover-cdp`, `hover-cdp2`, `hover-check`, `hover-css`, `hover-final`, `hover-robust`                                                                                                                                                                                                                                                                                                                                                               | All spent card-hover measurement iterations, no live target/ref. Delete the whole family?                                                                                                                                                                                                                                        |
| Screenshot one-offs (17)                       | `shot-extremes`, `shotfoot`, `shotfoot2`, `shot-footer`, `shot-hero`, `shot-hero-cf`, `shot-hero-wide`, `shot-packs`, `shot-pills-clean`, `shot-wide1920`, `snap-hero-full`, `snap-one`, `openpacks-shot`, `packs-fullshot`, `glow-shots`, `final-shot`, `final-hover`                                                                                                                                                                                                            | Spent hero/footer/packs screenshot one-offs. Any still re-run, or delete all?                                                                                                                                                                                                                                                    |
| Python image toolchain (27)                    | `avif_probe`, `avif_reencode_test`, `check_avif_sources`, `lama_compose.py`, `lama_config`, `lama_prep`, `compare_placard`, `detect_placard_bbox`, `measure_placard`, `detect_centers`, `fix_h020_watermark`, `mask_card_watermark`, `sweep_card_watermarks`, `extract_banner`, `extract_seam`, `seam_check`, `extract_frames`, `contact_sheet`, `crop_zoom`, `grid_overlay`, `make_patch`, `probe_grid`, `static_heatmap`, `zoom_card_bands`, `Poppins-Bold.ttf`                 | Whole bake/inpaint/placard/watermark Python toolchain — none imported by app/CI. Any reusable image ops worth keeping, or delete the family? (`Poppins-Bold.ttf` is only loaded by rebrand + `lama_compose` scripts — dies with them.)                                                                                           |
| Route-sweep QA (3)                             | `route-qa`, `responsive-qa`, `verify-all-routes`                                                                                                                                                                                                                                                                                                                                                                                                                                  | Hardcoded route lists are mostly-dead (`/claw`+`/marketplace`+`/repacks` mixed with live). Prune the dead routes (out of scope) or delete?                                                                                                                                                                                       |
| Sell / pack flow (ambiguous) (7)               | `capture-bulk-sell`, `capture-delivery`, `verify-phase1-sell`, `qa-pack-open-charge`, `qa-pack-order`, `qa-pack-tiers`, `pm-verify`                                                                                                                                                                                                                                                                                                                                               | Target the retired `/claw` sell/pack flow OR the current `/slots`-era flow? Keep the ones that still resolve?                                                                                                                                                                                                                    |
| Ambiguous capture/QA (mixed live+`/claw`) (10) | `capture-slots`, `demo-vault-flow`, `qa-topup`, `qa-locked-wins`, `qa-pack-1000-stress`, `qa-rm-sweep`, `qa-fluid`, `qa-hero`, `qa-motion-pass`, `launch-logged-in`                                                                                                                                                                                                                                                                                                               | Hit a live route **and** dead `/claw`. Repoint-and-keep or delete?                                                                                                                                                                                                                                                               |
| Admin surface verify (4)                       | `verify-admin-card-upload`, `verify-admin-odds-ui`, `verify-admin-pulls-ui`, `verify-win-rate-editor`                                                                                                                                                                                                                                                                                                                                                                             | Target live Medusa `/admin`; is the admin UI they check still current?                                                                                                                                                                                                                                                           |
| Misc one-offs (23)                             | `analyze-motion-recon`, `analyze-motion-recon2`, `audit-admin-capture`, `card-colors`, `card-measure-clone`, `check-dashboard-render`, `crop-card-pedestals`, `capture-liquid-glass`, `capture-margin-field`, `capture-rarity-dropdown`, `e2e-pc-ingest`, `eyeball-usd-sweep`, `firefox-header`, `firefox-open`, `generate-slot-sfx`, `gen-pokedex`, `hf`, `localize-myr`, `matte-card-backgrounds`, `matte-fix-flagged`, `measure-final`, `pill-exact`, `rebrand-polycards-logo` | Assorted spent one-offs. `rebrand-polycards-logo` = current brand generator (spent). Keep any as reusable?                                                                                                                                                                                                                       |
| Verify / showcase misc (8)                     | `verify-cardhover`, `verify-carousel`, `verify-hero-slide`, `verify-hover`, `verify-pixel-pokedex`, `verify-playwright`, `restore-backend-static`, `showcase/`                                                                                                                                                                                                                                                                                                                    | `restore-backend-static` = ops helper (restores backend static). `showcase/` (`lib.mjs`, `record-admin`, `record-admin-products`, `record-customer`, `record-guest`) is a demo-recording family — `record-customer` targets dead `/claw`, `record-admin*` target live `/admin`. Keep the admin recorders, drop the customer one? |

## Out of scope (untouched)

- `backend/packages/api/src/scripts/` — operational medusa-exec scripts (seeds,
  backfills, resets); different lifecycle, not part of this triage.
- Editing any surviving script's content (e.g. repointing `qa-csp`'s stale
  `/claw` route entry) — its own task.
- `docs/research/` — gitignored output dir.
