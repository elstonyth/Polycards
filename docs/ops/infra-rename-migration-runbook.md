# Runbook — rename prod infra `pokenic-*` → `polycards-*`

**Status:** planned, NOT executed. Run only in a scheduled maintenance window.
**Author:** 2026-07-15. **Owner to schedule the window + approve each phase.**

## Why this is a migration, not a rename

DigitalOcean provides **no rename** for a managed database cluster (the settings
page offers only _Destroy_), and Spaces/S3 bucket names are **immutable**. The
`pokenic` string is also baked into the DB connection host
(`pokenic-pg-do-user-…ondigitalocean.com`). The only way to get `polycards-*`
names is to **create new resources and cut over**. These names are invisible to
users/devs (the brand is already Polycards in repo, apps, project, code, domain),
so this buys cosmetic internal consistency at the cost of a risky prod migration.

## Scope

| Rename                                             | Method                               | Data risk                   |
| -------------------------------------------------- | ------------------------------------ | --------------------------- |
| `pokenic-pg` → `polycards-pg` (Postgres 16)        | DO **Fork** (backup→new cluster)     | HIGH — the live DB          |
| `pokenic-valkey` → `polycards-valkey` (Valkey 8)   | **Fresh empty** cluster (cache only) | LOW — cache rebuilds        |
| `pokenic-media` → `polycards-media` (Spaces, sgp1) | New bucket + copy + URL rewrite      | MED — scales with # uploads |

**Not renamable, left as-is:** the `*.ondigitalocean.app` app hostnames
(`pokenic-storefront-ijfiu`, `pokenic-backend-tltfm`) — DO-assigned, frozen at
creation, invisible behind `polycards.gg`. `admin@pokenic.app` login email
(optional, separate). Local Docker `pokenic-postgres`/`pokenic-redis` (local dev only).

## Current facts (2026-07-15)

- **pg**: id `5dc93810-cc8a-4172-aa94-6d08dd802094`, host `pokenic-pg-do-user-37988790-0.i.db.ondigitalocean.com:25060`, dbs `defaultdb` + `pokenic`, users `doadmin` + `pokenicapp`, project `8bb99a5f` (Polycards), ~$15/mo.
- **valkey**: id `a542f931-5b0f-4032-a613-53e3218f64a2`, host `pokenic-valkey-do-user-37988790-0.i.db.ondigitalocean.com:25061`.
- **bucket**: `pokenic-media`, region `sgp1`, endpoint `https://sgp1.digitaloceanspaces.com`, CDN `pokenic-media.sgp1.cdn.digitaloceanspaces.com`.
- **backend app**: `9011b06c-9908-4223-bf64-f96f66d702fa` (polycards-backend); **storefront**: `a3625ff4-64b3-41e8-8677-d08b65b9bbba`.
- **Media model**: card art = storefront-relative `/cdn/cards/*.webp` (static, NOT in the bucket). Only **admin-uploaded** files (S3 file provider, `bake-slab.ts` slabs) live in `pokenic-media` with **full URLs stored in the DB**.
- Cost during migration: ~2× DB cost (old + new run in parallel) until old are destroyed.

## Prerequisites

1. Maintenance window (expect ~30–60 min; write-downtime only during the DB cutover).
2. `doctl` authed; `psql`/`pg_dump` (PG16 client); `s3cmd` or `aws` CLI with the Spaces key/secret (from backend env `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`).
3. Your workstation IP added to each DB cluster's **Trusted sources** (Network Access) for the duration (remove after). See `[[prod-clone-workflow]]`.
4. Confirm no in-flight admin uploads / pack activations during the window.

---

## Phase 0 — Discovery + backups (no changes)

```bash
# 0a. Fresh manual backup of pg (belt-and-suspenders; DO also keeps daily backups)
doctl databases backups list 5dc93810-cc8a-4172-aa94-6d08dd802094

# 0b. Which DB + user does the app actually use? Read the live secret:
#     DO console → polycards-backend → Settings → App-Level Env → DATABASE_URL (reveal)
#     Record: db name (defaultdb vs pokenic), user, password. REDIS_URL host too.

# 0c. How much is actually in the bucket? (scopes the media risk)
s3cmd --host=sgp1.digitaloceanspaces.com --host-bucket='%(bucket)s.sgp1.digitaloceanspaces.com' \
  --access_key=$S3_KEY --secret_key=$S3_SECRET ls -r s3://pokenic-media/ | wc -l

# 0d. Which DB rows reference the bucket host? (the only URLs needing a rewrite)
psql "$DATABASE_URL" -c "
  SELECT table_name, column_name FROM information_schema.columns
  WHERE data_type IN ('text','character varying','jsonb');" # then grep candidates:
psql "$DATABASE_URL" -Atc "
  SELECT 'image', count(*) FROM image WHERE url LIKE '%pokenic-media%'
  UNION ALL SELECT 'product', count(*) FROM product WHERE thumbnail LIKE '%pokenic-media%';"
# Extend with any custom card/pack/slab tables that store a full media URL.
```

**Decision gate:** if 0c ≈ 0 objects and 0d ≈ 0 rows, the bucket step (Phase 3)
is trivial (new empty bucket + env swap, no copy/rewrite). Proceed accordingly.

### Phase 0 — MEASURED 2026-07-15 (app db = `pokenic`, 211 tables)

`pokenic-media` is **NOT** near-empty. **1165 URL references across 11 columns** —
so the bucket step is real work (full `sync` + these 11 rewrites), not a no-op:

| Column | Rows | Type |
|---|---|---|
| `pixel_pokemon.image_url` | 1025 | text |
| `image.url` | 46 | text |
| `product.thumbnail` | 46 | text |
| `product.metadata` | 40 | jsonb |
| `admin_action_audit.after` | 2 | jsonb (audit log — optional to rewrite) |
| `customer.metadata` | 1 | jsonb |
| `card.image` / `card.sprite_image` / `card.slab_image` | 1 each | text |
| `site_settings.slab_frame_url` | 1 | text |
| `site_settings.avatar_frames` | 1 | jsonb |

Bucket object count (0c) not measured — needs Spaces keys; expect ≈ the 1165
above (dominated by the 1025 pixel_pokemon sprites). Window estimate: DB fork +
bucket `sync` of ~1–1.2k objects + 11 UPDATEs → still ~30–60 min, mostly waiting
on the fork/sync. jsonb columns need `REPLACE(col::text,…)::jsonb`.

---

## Phase 1 — Postgres: fork → `polycards-pg`

```bash
# 1a. Enable maintenance mode on the backend app so no writes land mid-fork
#     DO console → polycards-backend → Settings → Maintenance mode → Turn on
#     (or scale backend+worker to 0 instances)

# 1b. Fork the cluster (DO console → pokenic-pg → Actions → "Fork database cluster")
#     Name the fork: polycards-pg. Same size/region (sgp1), same project (Polycards).
#     Fork restores from the latest backup → captures all dbs, users, data.
#     Wait until status = online.

# 1c. Get the NEW cluster's connection details (new host, and creds for the app user)
doctl databases list                       # note new cluster id
doctl databases connection <NEW_PG_ID> --format Host,Port,User,Password,Database
#     If the app user password differs on the fork, reset it or use the reported one.

# 1d. Build the new DATABASE_URL: same db name + user as 0b, new host.
#     Keep the "Public only" pattern (no ?sslmode=require in the URL — see .do spec note).
```

**Rollback (Phase 1):** app still points at the untouched `pokenic-pg`; just turn
maintenance off. Delete the fork.

---

## Phase 2 — Valkey: fresh `polycards-valkey`

```bash
# 2a. Create a NEW empty Valkey 8 cluster in sgp1, project Polycards, named polycards-valkey.
doctl databases create polycards-valkey --engine valkey --version 8 \
  --region sgp1 --size db-s-1vcpu-1gb --num-nodes 1
# 2b. Get its connection URI → new REDIS_URL. No data migration (cache/sessions/queues
#     rebuild). Active logins/among-flight jobs reset — acceptable in a window.
doctl databases connection <NEW_VALKEY_ID> --format URI
```

**Rollback (Phase 2):** revert REDIS_URL to the old cluster; delete the new one.

---

## Phase 3 — Spaces bucket → `polycards-media`

```bash
# 3a. Create the new bucket
s3cmd --host=sgp1.digitaloceanspaces.com mb s3://polycards-media
#     Set the same public-read policy as pokenic-media, and enable the CDN
#     (DO console → Spaces → polycards-media → Settings → Enable CDN).

# 3b. Copy all objects (skip if Phase 0c ≈ 0)
s3cmd --host=sgp1.digitaloceanspaces.com sync s3://pokenic-media/ s3://polycards-media/ --acl-public

# 3c. Rewrite stored full URLs in the DB (skip if 0d ≈ 0). Run PER table/column found:
psql "$DATABASE_URL" -c "
  UPDATE image SET url = REPLACE(url,
    'pokenic-media.sgp1.cdn.digitaloceanspaces.com',
    'polycards-media.sgp1.cdn.digitaloceanspaces.com')
  WHERE url LIKE '%pokenic-media%';"
#     Repeat for every column from 0d (product.thumbnail, custom slab/card tables, jsonb).
```

**Rollback (Phase 3):** old bucket + old URLs untouched until Phase 4 env swap;
revert the UPDATE with the reverse REPLACE. Keep `pokenic-media` until soak passes.

---

## Phase 4 — Repoint the app + IaC, redeploy

Update **backend** (`polycards-backend`) app-level env (DO console, one Save):

- `DATABASE_URL` → new pg (Phase 1d)
- `REDIS_URL` → new valkey (Phase 2b)
- `S3_BUCKET` → `polycards-media`
- `S3_FILE_URL` → `https://polycards-media.sgp1.cdn.digitaloceanspaces.com`

Update **storefront** (`polycards-storefront`):

- `NEXT_PUBLIC_MEDIA_HOST` → `polycards-media.sgp1.cdn.digitaloceanspaces.com`
  (this is baked at build → also update the **Dockerfile ARG** default + push).

Update **IaC** `.do/backend.app.yaml` + `.do/storefront.app.yaml`:

- `databases:` `name`/`cluster_name` → `polycards-pg` / `polycards-valkey`
- `S3_BUCKET`, `S3_FILE_URL`, `NEXT_PUBLIC_MEDIA_HOST`
- root `Dockerfile` ARG `NEXT_PUBLIC_MEDIA_HOST`

Turn **maintenance mode off** (or scale instances back). Redeploy both apps.

---

## Phase 5 — Verify

- Backend `/health` green; migrate job succeeded; worker healthy.
- `https://polycards.gg` loads; `/slots` renders; **admin-uploaded** images resolve
  from `polycards-media.sgp1.cdn…` (check network tab); card `/cdn/cards/*` still 200.
- Admin login works; do one test upload → lands in `polycards-media`.
- `psql "$NEW_DATABASE_URL" -Atc "SELECT count(*) FROM image WHERE url LIKE '%pokenic-media%';"` → **0**.
- No CORS/console errors.

## Phase 6 — Cleanup (after 24–48h soak)

- Destroy `pokenic-pg`, `pokenic-valkey`, empty + delete `pokenic-media` bucket.
- Remove your workstation IP from Trusted sources.
- Update memory `[[polycards-rename-and-golive]]`: infra now `polycards-*`.

## Rollback (whole cutover)

Because old resources are **untouched until Phase 6**, full rollback = revert the
Phase 4 env values (old DATABASE*URL/REDIS_URL/S3*\*), revert the Phase 3c UPDATE,
redeploy. Only Phase 6 (destroy) is irreversible — don't run it until fully verified.
