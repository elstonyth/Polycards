# SRC https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile

# ============================================
# Stage 1: Dependencies Installation Stage
# ============================================

# IMPORTANT: Node.js Version Maintenance
# This Dockerfile defaults to Node.js 24.14.1-slim to match the repo's Node 24 baseline.
# To ensure security and compatibility, update the NODE_VERSION ARG when the project's Node baseline changes.
ARG NODE_VERSION=24.14.1-slim

FROM node:${NODE_VERSION} AS dependencies

# Set working directory
WORKDIR /app

# Copy package-related files first to leverage Docker's caching mechanism
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* .npmrc* ./

# Install project dependencies with frozen lockfile for reproducible builds
RUN --mount=type=cache,target=/root/.npm \
  --mount=type=cache,target=/usr/local/share/.cache/yarn \
  --mount=type=cache,target=/root/.local/share/pnpm/store \
  if [ -f package-lock.json ]; then \
  npm ci --no-audit --no-fund; \
  elif [ -f yarn.lock ]; then \
  corepack enable yarn && yarn install --frozen-lockfile --production=false; \
  elif [ -f pnpm-lock.yaml ]; then \
  corepack enable pnpm && pnpm install --frozen-lockfile; \
  else \
  echo "No lockfile found." && exit 1; \
  fi

# ============================================
# Stage 2: Build Next.js application in standalone mode
# ============================================

FROM node:${NODE_VERSION} AS builder

# Set working directory
WORKDIR /app

# Copy project dependencies from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source code
COPY . .

ENV NODE_ENV=production

# Public (NEXT_PUBLIC_*) build inputs — baked into the client bundle at build
# time. The ARG DEFAULTS are the prod values (same approach as backend/Dockerfile's
# MERCUR_BACKEND_URL): App Platform does not reliably pass build-time env as
# docker build-args, so an EMPTY default would let `ENV X=$ARG` clobber the value
# to "" and ship a broken storefront. local docker-compose.prod.yml overrides via
# --build-arg. Update these if the backend gets a custom domain.
ARG NEXT_PUBLIC_MEDUSA_BACKEND_URL=https://admin.polycards.gg
ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_86273b7c12ca5b2fd838bf1c1cf6427dbb6ef41c723d8af1efa20db183517534
ARG NEXT_PUBLIC_MEDIA_HOST=polycards-media.sgp1.cdn.digitaloceanspaces.com
# Canonical public origin — baked into the client bundle so invite links (and
# metadataBase/sitemap) resolve to the real host, not the localhost dev default.
# Set to the live DO host; on a custom-domain move update this ARG + the .do
# spec + the backend's MERCUR_STOREFRONT_URL together.
ARG NEXT_PUBLIC_SITE_URL=https://polycards.gg
# Payment provider for the top-up sheet. Flipped to 'globepay' 2026-08-04, the
# cutover: the backend spec now carries GLOBEPAY_ENABLED=true plus the three
# secrets, and ALLOW_MOCK_TOPUP is gone from production — so the mock sheet had
# nothing left to call (topup-credits.ts refuses when mockTopupAllowed() is
# false). Moves together with the .do/storefront.app.yaml value. This ARG
# default is the one that reaches the bundle (App Platform build-time env is
# unreliable here), so flipping the spec alone does nothing.
ARG NEXT_PUBLIC_PAYMENTS_PROVIDER=tgpay
# Phone-OTP UI gate (CONTEXT.md → Deploy Order step 3). Flipped 2026-08-04 with
# the backend already serving /store/phone-verification/* and the Twilio
# secrets live-verified. Same rule as the provider ARG above: this default is
# what reaches the bundle — moves together with the .do/storefront.app.yaml
# value. The backend PHONE_VERIFICATION_REQUIRED flag (step 4) flips only
# after a build with this ARG is live, or phone signups 400.
# Off for a few hours on 2026-08-07 while Twilio refused every send with error
# 21608 (no approved primary compliance profile). Back on the same day: an
# Individual primary profile reached twilio-approved and a live send returned
# 201/pending. This ARG re-arms FIRST (step 3); the backend flag follows once
# a build carrying it is ACTIVE.
ARG NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true
# Withdrawal UI gate. Armed 2026-08-05 alongside the backend's
# GLOBEPAY_WITHDRAWALS_ENABLED (the actual money gate — this only renders the
# form). Same rule as the ARGs above: this default is what reaches the bundle;
# moves together with the .do/storefront.app.yaml value.
ARG NEXT_PUBLIC_WITHDRAWALS_ENABLED=true
# NOT a NEXT_PUBLIC_ var — server-side only, but it MUST be present at BUILD
# time all the same. next.config.ts picks the CSP header NAME via cspEnforced()
# and Next serialises headers() into routes-manifest.json during `npm run build`,
# so the value is frozen into the image. That makes a spec-only
# `do-apply.ps1 storefront` unable to flip it: the env reaches the RUNNING
# container but never the BUILD, and DO may skip the build entirely on an
# "app spec updated" deployment. Missing from this block is why production sat
# on Content-Security-Policy-Report-Only while .do/storefront.app.yaml had
# CSP_ENFORCE: 'true' (audit 2026-09-01). Same rule as the ARGs above: this
# default is what reaches the build; moves together with the spec value.
ARG CSP_ENFORCE=true
ENV NEXT_PUBLIC_MEDUSA_BACKEND_URL=$NEXT_PUBLIC_MEDUSA_BACKEND_URL
ENV NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_MEDIA_HOST=$NEXT_PUBLIC_MEDIA_HOST
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_PAYMENTS_PROVIDER=$NEXT_PUBLIC_PAYMENTS_PROVIDER
ENV NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=$NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED
ENV NEXT_PUBLIC_WITHDRAWALS_ENABLED=$NEXT_PUBLIC_WITHDRAWALS_ENABLED
ENV CSP_ENFORCE=$CSP_ENFORCE

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
# ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js application
# If you want to speed up Docker rebuilds, you can cache the build artifacts
# by adding: --mount=type=cache,target=/app/.next/cache
# This caches the .next/cache directory across builds, but it also prevents
# .next/cache/fetch-cache from being included in the final image, meaning
# cached fetch responses from the build won't be available at runtime.
RUN if [ -f package-lock.json ]; then \
  npm run build; \
  elif [ -f yarn.lock ]; then \
  corepack enable yarn && yarn build; \
  elif [ -f pnpm-lock.yaml ]; then \
  corepack enable pnpm && pnpm build; \
  else \
  echo "No lockfile found." && exit 1; \
  fi

# ============================================
# Stage 3: Run Next.js application
# ============================================

FROM node:${NODE_VERSION} AS runner

# Set working directory
WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the run time.
# ENV NEXT_TELEMETRY_DISABLED=1

# Copy production assets
COPY --from=builder --chown=node:node /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown node:node .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# If you want to persist the fetch cache generated during the build so that
# cached responses are available immediately on startup, uncomment this line:
# COPY --from=builder --chown=node:node /app/.next/cache ./.next/cache

# Switch to non-root user for security best practices
USER node

# Expose port 3000 to allow HTTP traffic
EXPOSE 3000

# Start Next.js standalone server
CMD ["node", "server.js"]