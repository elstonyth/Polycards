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

`storefront.app.yaml` has **one secret**, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
(build-time only — it keeps Server Action IDs stable across deploys; see the
comment on it in the spec). It is redacted to a `__SECRET__…__` placeholder and
injected exactly like the backend's. Everything else in that spec (backend URL,
publishable key, other `NEXT_PUBLIC_*`) is public by design.

`backend.app.yaml` has 4 secret env values (`DATABASE_URL`, `REDIS_URL`,
`JWT_SECRET`, `COOKIE_SECRET`) redacted to `__SECRET__<KEY>__` placeholders. The real
values live in **gitignored `deploy/.env.deploy`** and are injected at apply time
by `scripts/do-apply.ps1`. Never put a real secret in `.do/`.

If `deploy/.env.deploy` is lost, recreate it from the DO managed-DB connection
strings (Postgres + Valkey) plus the generated `JWT_SECRET` / `COOKIE_SECRET`
(rotate them if unknown). `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` can simply be
regenerated (32 random bytes, base64:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) —
a new value renames every Server Action once, so open tabs from before that
deploy must reload.

## Apply

```pwsh
pwsh scripts/do-apply.ps1 backend -Validate     # validate only, no live change
pwsh scripts/do-apply.ps1 backend               # validate + REDEPLOY prod
pwsh scripts/do-apply.ps1 storefront            # validate + REDEPLOY prod (1 secret)
```

The script injects secrets, writes a resolved spec to gitignored
`deploy/<app>.app.yaml`, runs `doctl apps spec validate`, then (without
`-Validate`) `doctl apps update`.

> **Deploys come from the GitHub `Deploy` workflow**
> (`.github/workflows/deploy.yml`), not from App Platform: push deploys are
> off on the live apps (`deploy_on_push: false` in these specs). On every push
> to **`master`**, each app is compared with the commit it is running and
> redeploys only if a file it builds from changed since then: anything under
> `backend/` except `backend/.claude/` for the backend (including backend
> Markdown), and the storefront's build inputs for the storefront. Root-level
> docs, `docs/`, agent config, `.github/` and `.do/` never trigger a deploy on
> their own, but any push catches an app up if it is behind on earlier
> changes, and an app whose diff can't be computed is deployed (safe default).
> Rules: `.github/scripts/deploy-targets.mjs`. Redeploy by hand from
> Actions → Deploy → Run workflow **on the `master` branch** (other branches
> skip the deploy jobs), target `both`, `backend` or `storefront`. It
> authenticates with the `DIGITALOCEAN_ACCESS_TOKEN` secret (scopes
> `app:read` + `app:update`, expires 2027-11-16; renew it before then). Spec
> changes (env, sizes) still reach the live app only via `do-apply.ps1`
> (doctl), which redeploys that app.

### Deploy gates

- **CI first.** The `wait for CI` job polls the `ci-ok` check run on the
  pushed commit (`.github/scripts/ci-gate.mjs`, self-check `--test`) for up
  to 60 minutes. Only `success` deploys. A failed, skipped or timed-out
  `ci-ok`, or none at all (a `[skip ci]` push), fails the run and nothing
  deploys. A `ci-ok` cancelled because a newer push replaced it is skipped
  quietly: that push's run ships the commit. After fixing or re-running CI,
  re-run the Deploy run's failed jobs. The gate relies on `ci-ok` concluding
  `success` on every green master push, including CI's master fast path.
- **Branch tip check.** App Platform builds the tip of `master`, not a given
  commit, so each deploy job re-reads the master head right before it starts
  a deployment and skips when master has moved on.
- **After ACTIVE.** `.github/scripts/verify-deploy.sh` checks that every
  component runs the pushed commit, then that
  `https://admin.polycards.gg/health` or `https://polycards.gg/healthz`
  answers 200. Any failed deploy step posts the run link to Discord through
  the `DISCORD_WEBHOOK` secret; without the secret the alert step does
  nothing.
- **`production` environment.** The plan, deploy and rollback jobs run in the
  GitHub `production` environment (created automatically by their first run).

### Owner setup for the `production` environment

GitHub can't do these for the agent; run them once as the repo owner, in
this order. Until step 3, the jobs keep reading the repo-level secret, so
nothing breaks in between.

1. Restrict the environment to `master` (Settings > Environments >
   production > Deployment branches and tags > Selected branches and tags >
   add `master`), or:

   ```bash
   gh api -X PUT repos/elstonyth/Polycards/environments/production      -F 'deployment_branch_policy[protected_branches]=false'      -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/elstonyth/Polycards/environments/production/deployment-branch-policies      -f name=master -f type=branch
   ```

2. Add the token and the webhook as environment secrets (each prompts for
   the value; paste it, never put it in the command line):

   ```bash
   gh secret set DIGITALOCEAN_ACCESS_TOKEN --env production
   gh secret set DISCORD_WEBHOOK --env production
   ```

3. After one green Deploy run on the environment secret, delete the repo-level
   copy: `gh secret delete DIGITALOCEAN_ACCESS_TOKEN`.

With the branch policy on, a Deploy or Rollback run dispatched from any other
branch fails at its first job instead of skipping.

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
- [ ] `CSP_ENFORCE=true` confirmed live on the storefront — verify the RESPONSE
      HEADER, not the spec. Setting it in `storefront.app.yaml` is necessary but
      NOT sufficient and `do-apply.ps1 storefront` alone can never flip it:
      `next.config.ts` bakes the header NAME into the build, the storefront
      builds from a Dockerfile (so the value must also be declared as
      `ARG CSP_ENFORCE` there), and DO skips the build entirely on an
      "app spec updated" deployment. Needs a real rebuild — a push to `master`
      does one. Then confirm:
      `curl -sI https://polycards.gg | grep -i content-security-policy`
      must return `content-security-policy` with NO `-report-only` suffix.
- [ ] A staging App Platform app (cheap `basic-xxs` pair) in front of prod —
      today every master push deploys straight to prod
- [ ] Backend error tracking (see Observability)
- [ ] Instance sizing/HA review (`basic-xs`/`basic-xxs`, single instance today)
