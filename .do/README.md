# `.do/` — DigitalOcean App Platform specs (IaC)

Single source of truth for the two App Platform apps. **Edit these files, then
apply** — never edit the apps in the DO web UI (that silently drifts from git).

| App                     | Spec                  | App ID                                 | Custom domain              | Default hostname                                      |
| ----------------------- | --------------------- | -------------------------------------- | -------------------------- | ----------------------------------------------------- |
| Backend (Medusa/Mercur) | `backend.app.yaml`    | `7fd66ea2-0105-420b-87eb-8a4606262561` | https://admin.polycards.gg | https://polycards-backend-gce6p.ondigitalocean.app    |
| Storefront (Next.js)    | `storefront.app.yaml` | `4bf179e0-70a8-4fd7-bd25-9be43e9d0319` | https://polycards.gg       | https://polycards-storefront-fzrft.ondigitalocean.app |

Both apps were **recreated from scratch 2026-07-16** (the original apps carried
frozen `pokenic-*` default hostnames from creation; DO can't rename a default
hostname, so the only way to get `polycards-*` ones was destroy + recreate). The
recreate: create new app from the spec (no domains) → add the new app to the DB
trusted sources → verify on its default host → move the custom domain + flip the
Cloudflare CNAME to the new default host → destroy the old app. The default
hostnames above have random suffixes DO assigns at creation; they're referenced
in the Dockerfile ARG defaults / storefront `NEXT_PUBLIC_MEDUSA_BACKEND_URL` only
as fallbacks — the custom domains are the real origins.

## Secrets

`storefront.app.yaml` has **no secrets** (the backend URL + publishable key are
`NEXT_PUBLIC_*`, public by design) — it is committed verbatim.

`backend.app.yaml` has 4 secret env values (`DATABASE_URL`, `REDIS_URL`,
`JWT_SECRET`, `COOKIE_SECRET`) redacted to `__SECRET__<KEY>__` placeholders. The real
values live in **gitignored `deploy/.env.deploy`** and are injected at apply time
by `scripts/do-apply.ps1`. Never put a real secret in `.do/`.

If `deploy/.env.deploy` is lost, recreate it from the DO managed-DB connection
strings (Postgres + Valkey) plus the generated `JWT_SECRET` / `COOKIE_SECRET`
(rotate them if unknown).

## Apply

```pwsh
pwsh scripts/do-apply.ps1 backend -Validate     # validate only, no live change
pwsh scripts/do-apply.ps1 backend               # validate + REDEPLOY prod
pwsh scripts/do-apply.ps1 storefront            # storefront has no secrets
```

The script injects secrets, writes a resolved spec to gitignored
`deploy/<app>.app.yaml`, runs `doctl apps spec validate`, then (without
`-Validate`) `doctl apps update`.

> **`deploy_on_push: true`** — both apps auto-deploy on every push to
> **`master`** (see the `github.branch` keys in the specs). So merging a PR
> redeploys prod just like `do-apply.ps1` does. Pushing spec/Dockerfile changes
> = a live deploy. Spec **env** changes, however, only reach the live app via
> `do-apply.ps1` (doctl), not via git push.

## Admin user

The PRE_DEPLOY `migrate` job permanently runs `deploy:migrate-user`
(`db:migrate` + `create-admin.ts` + `seed-vip-achievements.ts`). Creation is
**idempotent** — `create-admin.ts` checks for an existing user and SKIPS
without throwing — so it is safe on every deploy and self-heals a lost admin.
`ADMIN_EMAIL` / `ADMIN_PASSWORD` in `backend.app.yaml` feed it.

## Rollback

App Platform keeps previous deployments; a bad deploy rolls back without a git
revert:

```pwsh
doctl apps list-deployments <APP_ID>                 # find the last good deployment
doctl apps create-deployment <APP_ID> --wait         # redeploy current spec (rebuild)
# Pin to a previous deployment (true rollback, no rebuild):
doctl apps create-rollback <APP_ID> --deployment-id <DEPLOYMENT_ID> --wait
doctl apps validate-rollback <APP_ID> --deployment-id <DEPLOYMENT_ID>  # dry-run first
```

**Migration rule that makes rollback survivable:** migrations must stay
backward-compatible for one release (expand/contract — add columns/tables
first, remove in a later release). The PRE_DEPLOY job migrates forward only;
a rollback runs OLD code against the NEW schema.

## Backups & restore

The managed Postgres cluster (`polycards-pg`, `production: true`) takes **daily
automatic backups** (verified 2026-07-07: daily snapshots at ~06:48 UTC, 7-day
retention) and supports point-in-time recovery:

```pwsh
doctl databases backups <CLUSTER_ID>                                  # list
doctl databases create <name> --restore-from-cluster <CLUSTER_ID> `
  --restore-from-timestamp <RFC3339>                                  # PITR -> NEW cluster
```

Restore creates a **new** cluster — repoint `DATABASE_URL` in
`deploy/.env.deploy`, re-run `do-apply.ps1 backend`, and re-add the
`app:$APP_ID` trusted source on the new cluster.

Ad-hoc dumps (local Docker dev DB or remote): `pwsh scripts/db-dump.ps1`
(local) / `pwsh scripts/db-dump.ps1 -DatabaseUrl <url>` (remote) → `backups/`
(gitignored).

## Observability

- **Storefront:** Sentry is wired via `@sentry/nextjs` (`next.config.ts`).
- **Backend:** no Sentry yet — errors live only in App Platform runtime logs
  (`doctl apps logs <APP_ID> --type run [--follow]`). The specs' alert rules
  (deploy failures, CPU/MEM/restart) are the floor. TODO(go-live): add backend
  error tracking (Sentry DSN decision) or a log drain
  (`doctl apps update ... --log-destination`).

## Go-live checklist (grep-able blockers)

- [ ] `ALLOW_MOCK_TOPUP` env **deleted** from `backend.app.yaml` + real PSP live
      (see the GO-LIVE BLOCKER box in the spec)
- [ ] `CSP_ENFORCE=true` confirmed live on the storefront (in the spec; applies
      via `do-apply.ps1 storefront`)
- [ ] A staging App Platform app (cheap `basic-xxs` pair) in front of prod —
      today every master push deploys straight to prod
- [ ] Backend error tracking (see Observability)
- [ ] Instance sizing/HA review (`basic-xs`/`basic-xxs`, single instance today)
