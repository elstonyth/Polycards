# Trading Card Pack Collectibles Platform

A physical/digital trading-card-pack collectibles platform — built as a Next.js 16 storefront on top of a Medusa v2 + Mercur marketplace backend.

The experience: pack drops, a claw machine, a vault, a marketplace, and a leaderboard, in a clean, full-bleed, dark-mode codebase.

## What's inside

- **Storefront** (`src/`) — Next.js 16 (App Router, React 19, TypeScript strict), ~36 routes including the home page, `/claw`, `/how-it-works`, `/leaderboard`, `/marketplace`, `/pack-party`, and an account area (vault, orders, transactions, settings, referrals).
- **Backend** (`backend/`) — a [Medusa v2](https://medusajs.com/) + [Mercur](https://mercurjs.com/) (multi-vendor) commerce API at `backend/packages/api`, plus an admin dashboard at `backend/apps/admin`.
- **Credit economy** — top-up, per-customer credit charging, public profiles, a client-side demo spin, forgot-password, a card vault, two-tier buyback, stock-aware pack pulls, and a DB-aggregated leaderboard.

## Tech Stack

| Layer         | Choice                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| Storefront    | Next.js 16 · React 19 · TypeScript (strict)                                        |
| Styling       | Tailwind CSS v4 · hardcoded dark neutrals                                          |
| UI primitives | shadcn-style components on `@base-ui/react` · Lucide icons                         |
| Animation     | Framer Motion (`motion`) + a custom scroll-reveal engine (`src/lib/use-reveal.ts`) |
| Backend       | Medusa v2 + Mercur (multi-vendor marketplace)                                      |
| Data          | PostgreSQL · Redis (via Docker)                                                    |
| Deploy        | DigitalOcean App Platform + Spaces (media)                                         |

Fonts: **Nekst Black** (self-hosted) for headings, **Geist** for body. The site is full-bleed by design — no `max-w-*` caps; the `.px-fluid` gutter scales padding continuously from mobile to 4K.

## Prerequisites

- [Node.js](https://nodejs.org/) 24+
- Docker (Postgres + Redis for the backend)
- `corepack` (the backend uses Yarn via corepack)

## Quick Start (storefront)

```bash
npm install
npm run dev          # http://localhost:3000
```

> **Verify against a production build, not `next dev`.** `next dev` serves images
> slowly on some machines and makes a correct build _look_ broken. `next.config.ts`
> sets `output: 'standalone'`, which makes `npx next start` unusable — serve the
> standalone bundle instead:
>
> ```bash
> npm run build
> pwsh scripts/serve-standalone.ps1 -Port 4000
> ```

## Running the backend

First time on a machine: create the shared dev containers (Postgres 16 as
user/db `medusa`, Redis 7) — `pwsh scripts/launch-stack.ps1` ensures
`pokenic-postgres` + `pokenic-redis` exist and are running (it also boots the
full stack). Thereafter they restart themselves (`--restart unless-stopped`);
a plain `docker start pokenic-postgres pokenic-redis` also works.

```bash
# Postgres + Redis stay up via Docker (--restart unless-stopped)
cd backend/packages/api && corepack yarn dev     # Medusa API on :9000 (health: /health)
cd backend/apps/admin   && node ../../node_modules/vite/bin/vite.js   # Admin on :7000
```

## Commands

```bash
npm run dev        # Start dev server
npm run build      # Production build
npm run start      # next start (prefer serve-standalone.ps1 — see above)
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run check      # lint + typecheck + build
npm run format     # Prettier write (src, scripts)
npm run test       # Vitest
```

### Docker

```bash
docker compose up app --build   # production build
docker compose up dev --build   # dev mode on port 3001
```

## Architecture

- **Section composition + scroll-in animation is the core pattern.** `src/app/page.tsx` stacks section components, wrapping most in `<Reveal>` (fade-up on scroll-into-view). The engine — `useInView` + `usePrefersReducedMotion` (`src/lib/use-reveal.ts`) — honors `prefers-reduced-motion` everywhere. Sections with their own internal scroll animation (`HowItWorksSection`, `LeaderboardSection`) are intentionally not double-wrapped.
- **Server/client split.** Route `page.tsx` files stay server components and export `metadata`; interactivity moves to a sibling `'use client'` component (canonical example: `marketplace/page.tsx` → `marketplace/MarketplaceClient.tsx`).
- **Global shell.** `src/app/layout.tsx` forces dark mode and wraps every page in `SiteHeader` + `SiteFooter`. The palette is hardcoded Tailwind neutrals, not the shadcn oklch tokens.

## Measurement-driven UI

UI work is measurement-driven, not eyeballed. The `scripts/*.mjs` Playwright scripts read computed styles and `getBoundingClientRect`, dumping screenshots and JSON into `docs/research/`. Per-component specs (exact computed CSS, states, content, responsive breakpoints) live in `docs/research/components/*.spec.md`. Verify with the Playwright scripts (screenshots → `docs/research/*.png`), not ad-hoc browser sessions.

## Project Structure

```
src/
  app/                # Next.js routes (~36)
  components/
    ui/               # shadcn-style primitives on @base-ui
  lib/                # cn(), use-reveal.ts, utilities
  hooks/              # custom React hooks
public/
  fonts/ images/ videos/ seo/
backend/
  packages/api/       # Medusa v2 + Mercur commerce API
  apps/admin/         # Admin dashboard (Vite)
docs/
  research/           # component specs, page topology, measurement output
scripts/              # Playwright capture/measure/QA + serve-standalone.ps1
AGENTS.md             # Agent instructions (single source of truth)
CLAUDE.md             # Claude Code config (imports AGENTS.md)
```

## Deployment

Deploys to **DigitalOcean App Platform** (managed via the `doctl` CLI). Both the storefront and backend build from `git master` with `deploy_on_push`, so code changes ship via commit + push. Media is served from a DigitalOcean Spaces bucket + CDN. See `docs/HANDOFF.md` for operational details.

## License

MIT — see [LICENSE](LICENSE).
