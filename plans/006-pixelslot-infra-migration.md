# 006 — PixelSlot infra migration (PLAN ONLY, NOT EXECUTED)

Status: **draft, nothing here has been run.** Every stage needs explicit sign-off.
The cosmetic rebrand is done and is **merged to `master`** (#122–#124); `master` is
level with `origin/master`. This file covers only the parts that touch live
infrastructure.

> **No credentials in this file.** `doctl databases list` / the DO MCP
> `db-cluster-list` return **plaintext** passwords for `doadmin`, `pokenicapp`,
> and Valkey. Do not paste that output into commits, issues, or chat logs.

## Already done (verified against the live API, 2026-07-10)

| Thing                                                  | State                                                  |
| ------------------------------------------------------ | ------------------------------------------------------ |
| GitHub repo                                            | renamed → `elstonyth/PixelSlot`                        |
| DO app names                                           | already `pixelslot-backend`, `pixelslot-storefront`    |
| `github.repo` on all 3 backend components + storefront | `elstonyth/PixelSlot`, `deploy_on_push: true`          |
| `.do/*.app.yaml` repo slug + app name                  | fixed, matches live, `doctl apps spec validate` passes |

Deploys are **not** broken. This was checked, not assumed.

## The hostname rule — it differs by resource type

This is the single most important fact in this document, and it is not intuitive.

**App Platform: the hostname does NOT follow the name.**
The apps were renamed to `pixelslot-*`, yet still serve on
`pokenic-backend-tltfm.ondigitalocean.app` and `pokenic-storefront-ijfiu.ondigitalocean.app`.
DO assigns `<name-at-creation>-<random>` once and never revisits it. Renaming an
app is therefore **safe and already done**. Do not "fix" these hostnames to match.

**Managed databases: the hostname DOES embed the cluster name.**
Both hosts take the form `<cluster-name>-do-user-<id>-0.i.db.ondigitalocean.com` — the
cluster name is a literal substring of the connection hostname. (Full hostnames
deliberately omitted: this repo is public. Get them from `doctl databases list`.)

> **VERIFY BEFORE ACTING:** it is _likely_ that renaming the cluster rewrites the
> connection hostname, which would invalidate the encrypted `DATABASE_URL` /
> `REDIS_URL` secrets in both app specs. This has **not** been confirmed. Test on a
> throwaway cluster first. If it does rewrite, a DB rename is a connection-string
> migration with downtime, not a cosmetic rename.

## Never rename these (no visible gain, real user-facing breakage)

| Identifier               | File                                               | Breaks if renamed                                                                  |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `_pokenic_jwt`           | `src/lib/data/customer.ts`                         | logs out **every** signed-in user                                                  |
| `pokenic_ref`            | `src/lib/referral-cookie.ts`                       | drops every in-flight referral's stashed sponsor                                   |
| `pokenic.cookie-consent` | `src/lib/consent.ts`                               | re-prompts consent for everyone                                                    |
| `pokenic.slot.muted`     | `src/lib/use-sound.ts`                             | resets mute preference                                                             |
| `pokenic:auth`           | `AuthButton` / `AuthModal` / `ResetPasswordClient` | in-page event; safe only if all 4 sites change atomically. Zero user-visible gain. |
| `pokenicCardOverlay`     | `CardDetailOverlay.tsx`                            | `history.pushState` key; a rename mid-session can break `back()`                   |

These are storage keys, not brand. Leaving them is the correct call.

## Stages

Each stage is independently revertable and gated. Do not batch them.

### Stage 1 — Spaces bucket `pokenic-media` → `pixelslot-media`

**Hardest stage. A bucket cannot be renamed.** Highest blast radius: every card image.

1. Create bucket `pixelslot-media` (sgp1), enable CDN.
2. Copy all objects (`s3cmd sync` / `rclone`). Do **not** delete the source.
3. Audit parity with `scripts/audit-media.mjs` before any cutover.
4. **DB rewrite:** Medusa's S3 provider stores _absolute_ URLs, so image rows contain
   `https://pokenic-media.sgp1.cdn.digitaloceanspaces.com/...`. These must be rewritten.
   `backend/packages/api/src/scripts/reupload-images.ts` and `repull-pc-images.ts` are
   the closest existing tooling — neither is a rename script; expect to write one.
   Take a DB snapshot first (`pokenic-pg` has daily backups; do not rely on them alone).
5. Update `S3_BUCKET`, `S3_FILE_URL` (backend) and `NEXT_PUBLIC_MEDIA_HOST` (storefront).
   `NEXT_PUBLIC_MEDIA_HOST` is **BUILD_TIME** — it is baked into the bundle and feeds both
   `next.config.ts` `images.remotePatterns` and the CSP in `src/lib/security/csp.ts`.
   A stale value means images 404 _and_ get CSP-blocked. Storefront must rebuild.
6. Keep the old bucket live for a deprecation window. Delete only after traffic confirms.

Rollback: revert env + rebuild; old bucket never left serving.

### Stage 2 — Domains and mailboxes

Blocked on actually owning the PixelSlot domain.

- `hello@pokenic.com` — `src/app/about/page.tsx` (×3), `src/app/contact/page.tsx`
- `admin@pokenic.app` — `ADMIN_EMAIL`, backend spec. Feeds the idempotent `create-admin`
  PRE_DEPLOY job; changing it **creates a second admin**, it does not rename the first.
- `docs.pokenic.com/user-agreements/privacy-policy` — `src/components/CookieConsent.tsx`,
  a live external URL. Must resolve before it is swapped.
- `STORE_CORS`, `MERCUR_STOREFRONT_URL`, `MERCUR_BACKEND_URL` reference the
  `pokenic-*.ondigitalocean.app` hostnames. Those hostnames are permanent (see above) —
  only touch these when moving to a custom domain.

**Sibling coupling:** `../Pokenic-Redeem-Page` depends on `pokenic.com` and
`pokenicredeem.com`. A domain move breaks it. Migrate together or not at all.

### Stage 3 — Managed databases (optional, lowest value)

Cluster `pokenic-pg` (PG 16, `production: true`), inner DB `pokenic`, app user `pokenicapp`;
cluster `pokenic-valkey` (Valkey 8, `production: true`).

Gated on the hostname question above. **Recommendation: skip this entirely.** Cluster names
are invisible to users, and the only outcome on offer is a downtime window plus a chance of a
bad connection string. Cosmetic value: zero.

If it proceeds: rename cluster → confirm whether host changed → update `cluster_name` in
`.do/backend.app.yaml` → re-encrypt `DATABASE_URL` / `REDIS_URL` → `do-apply.ps1 backend -Validate`
→ apply → verify `/health`.

### Stage 4 — Art assets (not a string change)

The claw-machine AVIF/webp have the brand baked into the pixels, frame by frame: the banner
wordmark, the placard reading `pokenic claw.`, and the base URL `pokenic.com`. See the comment
at `src/app/slots/[slug]/PackDetailClient.tsx:157`. `SlabCard.tsx:5` documents a rainbow-holo
Pokenic monogram on the card back.

No find-and-replace reaches these. They need re-rendering. `scripts/rebrand-pixelslot-logo.mjs`
(now on `master`) handles the logo/icon set only, not the claw frames.

## Explicitly out of scope

- `.do` app hostnames — permanent by design, not broken.
- The six runtime storage keys above.
- Test fixture emails (`a@pokenic.app` in `src/lib/actions/__tests__/auth.test.ts`) — harmless.
- The three `@pokenic` testimonial quotes in `how-it-works/page.tsx` — attributed real quotes;
  rewriting them is a product/legal call, not a rename.

## Recommended order

Stage 4 (assets, zero risk) → Stage 1 (bucket, gated) → Stage 2 (domains, gated on ownership).
Stage 3: don't.
