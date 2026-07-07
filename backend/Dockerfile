# Mercur/Medusa backend image for DigitalOcean App Platform (git-based build).
#
# Build context MUST be the backend monorepo root (this dir): the Yarn 4
# workspace (packages/api + packages/odds-math + packages/pokemon + apps/admin + apps/vendor) is built together by
# turbo, and the running server resolves the admin/vendor dashboards from the
# SOURCE `apps/*/dist` via medusa-config's `appDir: __dirname/../../apps/*`.
# That relative path only resolves when the whole monorepo is preserved in the
# image — verified locally (medusa start serves /dashboard + /seller). Do NOT
# try to ship only `packages/api/.medusa/server`; the dashboards would 404
# ("Dashboard not built").
#
# Node 22 LTS: Medusa 2.13 targets Node 20/22; satisfies engines ">=20". Bump
# to 24 only if a parity issue surfaces (the local baseline runs 24).
ARG NODE_VERSION=22-slim

# ============================================================
# Stage 1: build the whole workspace (api .medusa + apps dist)
# ============================================================
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# Toolchain for any native addon rebuilds (node-gyp deps); removed with the
# stage — never reaches the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Yarn 4 via corepack (pinned by package.json "packageManager": yarn@4.5.0).
RUN corepack enable

# Copy only manifests first so `yarn install` is cached until a dependency
# actually changes. Every workspace package.json must be present before install.
COPY package.json yarn.lock .yarnrc.yml turbo.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/odds-math/package.json ./packages/odds-math/
COPY packages/pokemon/package.json ./packages/pokemon/
COPY apps/admin/package.json ./apps/admin/
COPY apps/vendor/package.json ./apps/vendor/
RUN corepack yarn install --immutable

# Backend origin baked into the admin/vendor vite bundles at build time (the
# vite configs read process.env.MERCUR_BACKEND_URL; turbo.json `env` lets it
# through to the build task). App Platform does NOT reliably pass build-time
# env as docker build-args, so this default IS the prod value — the Dockerfile
# is the prod artifact (local dev uses `medusa develop`, not this image).
# Update this if the backend gets a custom domain.
ARG MERCUR_BACKEND_URL=https://pokenic-backend-tltfm.ondigitalocean.app
ENV MERCUR_BACKEND_URL=$MERCUR_BACKEND_URL

# Storefront origin baked into the admin bundle (vite define __STOREFRONT_URL__):
# the admin resolves storefront-relative asset paths (/cdn, /home, /images)
# against this, since in prod the storefront is a SEPARATE domain from the admin.
# Hardcoded default like MERCUR_BACKEND_URL above (App Platform doesn't reliably
# pass build-time env as build-args). Update if the storefront gets a custom domain.
ARG MERCUR_STOREFRONT_URL=https://pokenic-storefront-ijfiu.ondigitalocean.app
ENV MERCUR_STOREFRONT_URL=$MERCUR_STOREFRONT_URL

# Full source, then build (turbo: medusa build -> packages/api/.medusa,
# vite build -> apps/{admin,vendor}/dist). No DB/Redis needed at build time.
COPY . .
RUN corepack yarn build

# Slim the runtime image: drop apps/{admin,vendor}/node_modules. The dashboards
# are served from the pre-built static apps/*/dist (self-contained vite bundles);
# their node_modules are build-only dead weight at runtime (~600MB).
#
# NOTE: we deliberately do NOT `yarn workspaces focus --production` to prune dev
# deps. `medusa start` runs from packages/api and loads the medusa-config.ts
# SOURCE via @medusajs/utils dynamic-import (a plain require with a TS hook that
# lives in dev deps) — pruning them breaks config load ("Cannot find module
# .../medusa-config"). Running from the compiled .medusa/server would avoid that
# but breaks the appDir -> apps/*/dist resolution. So dev deps stay. Verified by
# scripts/preflight.ps1 (boot + /dashboard + /seller render).
RUN rm -rf apps/admin/node_modules apps/vendor/node_modules

# ============================================================
# Stage 2: runtime — preserve the built monorepo, start the API
# ============================================================
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app

# Pre-activate Yarn 4 at build time so container start needs no network.
# COREPACK_HOME must be world-readable and set at RUNTIME too: the prepare runs
# as root, but the CMD runs as USER node — with the default per-user cache
# (~/.cache/node/corepack) the activation would be invisible to node and
# corepack would re-download yarn at container start (or fail without network).
ENV COREPACK_HOME=/corepack
RUN corepack enable && corepack prepare yarn@4.5.0 --activate \
  && chmod -R a+rX /corepack

# Copy the built workspace from the builder, owned by `node`. The container runs
# as USER node (below), and `medusa db:migrate` (the App Platform pre-deploy job)
# writes generated migration dirs INTO node_modules —
# `node_modules/@medusajs/*/dist/migrations` and `@mercurjs/core/.medusa/.../migrations`.
# Without --chown those dirs are root-owned and the migrate job fails with
# `EACCES: permission denied, mkdir ...` → deploy error → rollback. Owning the
# whole tree as node lets migrate create them.
COPY --chown=node:node --from=builder /app ./

# Medusa listens on :9000; App Platform routes to http_port: 9000 (see app.yaml).
# Worker instances override the run command with MEDUSA_WORKER_MODE=worker.
WORKDIR /app/packages/api

# Drop root (the storefront Dockerfile already does; audit M2). The tree is
# node-owned via the --chown COPY above, so the runtime can write both the
# migrate-generated migration dirs and static/ (the LOCAL file-provider fallback
# when S3 is unset — compose/local runs; prod uses Spaces so it stays untouched).
RUN mkdir -p static && chown node:node static
USER node

EXPOSE 9000
# In-image health probe (App Platform has its own; this helps local/compose +
# `docker` orchestration). Node's global fetch (Node 18+) avoids needing curl.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:9000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["corepack", "yarn", "start"]
