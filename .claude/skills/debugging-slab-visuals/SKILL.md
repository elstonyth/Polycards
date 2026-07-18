---
name: debugging-slab-visuals
description: >
  Diagnose and fix any "the graded slab looks wrong on the storefront" report —
  white halo, gray edge around the card, cut-off/clipped tier glow, sharp corner
  squares, an animated/floating frame, a doubled frame, or a missing tier frame
  (e.g. bare slabs in the vault). Use whenever a slab/card renders wrong on the
  Polycards storefront, ESPECIALLY when it "stays wrong after a fix" — the usual
  cause is a stale local prod build, a stale stored composite, or a surface that
  never passed the `rarity` prop, not the change you just made. Also covers how
  to verify a slab change on the local :4000 build.
license: MIT
metadata:
  author: harvested
  version: "1.0"
---

# Debugging graded-slab visuals

A slab render bug lives in exactly ONE of three layers. Identify the layer
first — most wasted time here comes from fixing the wrong one (or "fixing" code
that's already correct and just isn't being rebuilt/rebaked).

**Failure pattern:** a slab looks wrong on the storefront and *stays* wrong after
a code fix — because you're viewing a stale prod build (`launch-stack` reused
`.next`, and `-Rebuild` silently no-op'd), a stale stored composite (no rebake),
or the surface never passed `rarity` so the tier frame was never rendered at all.
**Verified by:** jest bake byte-identical to the approved output + all 50
`bake-slab` unit tests pass + Playwright screenshots on `:4000` confirmed the
fixed pool halo and the logged-in vault tier frame (this session, 2026-07-18).

## The three layers (triage this first)

1. **Baked composite** — `backend/packages/api/src/api/admin/media/bake-slab.ts`
   (`composeSlab`). Owns the slab IMAGE itself: card fills the window, recess,
   die-cut corners, PSA label, white-halo/gray-edge. It is ONE stored `.webp`
   per card (`Card.slab_image`), rendered identically on every surface — so a
   bad composite looks the same everywhere and a rebake fixes all at once.
   Deep specifics + the jest bake harness: see the memory note
   `slab-compose-geometry-fix`.
2. **Frontend render** — `src/components/SlabImage.tsx` and its call sites:
   `cards/CardTile.tsx` (pool tile), `slots/[slug]/PoolByRarity.tsx` (rarity
   rail), `slots/[slug]/PackDetailClient.tsx`, `cards/CardDetail.tsx` (card
   hero), `(account)/vault/VaultClient.tsx`, `RecentPullsSection.tsx`. Owns the
   **tier frame band + glow halo + any animation** wrapped around the slab.
3. **Stale artifact** — the storefront is a prod build served from
   `.next/standalone`; stored composites are baked data. A correct fix in layer
   1/2 is invisible until you rebuild (layer 2) or rebake (layer 1).

Decide the layer: is the baked IMAGE wrong (→ layer 1)? Is the frame/glow/
animation wrong or absent while the card image is fine (→ layer 2)? Does it look
old despite a committed fix (→ layer 3)?

## Procedure

- [ ] 1. **Triage the layer** (above). If unsure whether the composite is wrong,
      bake it fresh (layer-1 harness in `slab-compose-geometry-fix`) rather than
      trusting a `docs/research/preview-*.png` — those are gitignored and go stale.
- [ ] 2. **Layer 2 (frontend):** the tier frame band + halo only render when
      `SlabImage` receives the `rarity` prop. A surface passing only `slabSrc`
      shows the BARE baked slab (this was the vault bug — fixed by adding
      `rarity={item.card.rarity}`). Animation lives in `CardDetail.tsx`
      (framer-motion `motion.div animate={{ y:[0,-6,0] }}` idle float), NOT in
      `SlabImage`. Halo clipping on pool rails: `PoolByRarity` rails are
      `overflow-x-auto`, which forces `overflow-y` to clip too and cuts the
      offset-0 box-shadow halo; give the rail padding (halo room lives in the
      padding) + a negative margin capped at the `px-fluid` gutter (`-mx-4`) so
      it never triggers page x-scroll.
- [ ] 3. **Rebuild before judging a layer-2 fix** (see Gotchas — `-Rebuild`
      no-ops if `:4000` is up). Stop `:4000`, then `-Rebuild`:
      ```
      Get-NetTCPConnection -LocalPort 4000 -State Listen | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }
      pwsh scripts/launch-stack.ps1 -Verify -Rebuild
      ```
- [ ] 4. **Rebake after a layer-1 fix** so stored composites reflect it. Backend
      must be RUNNING (localhost card-image URLs), then from `backend/packages/api`:
      `corepack yarn medusa exec ./src/scripts/bake-slab-images.ts`. In prod the
      trigger is one admin → Storefront settings save (fires `rebakeAllGradedCards`).
- [ ] 5. **Verify on `:4000` with Playwright** (prod standalone; NOT `next dev`
      :3001, NOT Chrome MCP). Public surfaces (card page, `/slots` pool) need no
      login. The **vault needs customer login** — see Gotchas for the account.

### Example — isolate frame-vs-compositor

Bake the same card with a TRANSPARENT frame vs the real frame (layer-1 harness);
the delta at the card edge is the frame webp's own lip, the rest is `composeSlab`.
Full recipe in the `slab-compose-geometry-fix` memory note.

## Gotchas

- **`-Rebuild` is a no-op if `:4000` is already serving.** `launch-stack.ps1` is
  idempotent and reuses the running server — you MUST kill port 4000 first, then
  `-Rebuild`. This silently served a build ~1.5h stale and looked like the fix
  didn't work / a regression.
- **The `rarity` prop gates the tier frame.** No `rarity` → `SlabImage` renders
  the bare baked slab (no band, no halo). Check every call site.
- **Don't trust `docs/research/preview-*.png`.** Gitignored, local, often stale
  (a 24h-old preview misdiagnosed a fix as broken for ~an hour). Bake fresh.
- **Stored composites don't change on deploy.** After merging a `composeSlab`
  fix, prod slabs stay old until a rebake (admin Storefront save).
- **Vault login:** customer `test@pokenic.app`, admin `admin@pokenic.app` (the
  accounts kept pokenic names post-rebrand — the launch scripts wrongly default
  to `test@polycards.app`). Password ONLY in gitignored `scripts/.dev-logins`
  (`CUST_PW`) — never hardcode it. The header-login modal signals success when
  `input[name="email"]` **detaches**, not when the Login button hides. See the
  `browser-verifying-a-spin` memory note.
- **One composite, every surface.** A wrong bake is identical on card page, pool,
  vault, profile; one rebake fixes them all — don't chase per-surface "fixes".

## What didn't work

- **Trusting `preview-baked-slabs-v17.png` as current output** — it was 24h old;
  the real code already differed. Bake fresh via the jest harness instead.
- **Calling the "double frame" a code regression** — it was purely a stale local
  build; the fix (#203) was already in the branch. A rebuild resolved it, no code.
- **Running `launch-stack.ps1 -Rebuild` with `:4000` up** — reused the old build.
- **Grepping only `SlabImage.tsx` for the "animation"** and concluding there was
  none — the idle float was in `CardDetail.tsx` (framer-motion). Grep all slab
  call sites, not just the shared component.
- **Vault login with `test@polycards.app`** (script default) — wrong account;
  it's `test@pokenic.app`.
