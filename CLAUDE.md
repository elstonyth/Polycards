# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> `AGENTS.md` (imported above) is the source-of-truth for tech stack, code style, design
> principles, and the generic clone-website template structure. **Don't repeat it here.**
> Everything below is what's specific to *this* repo and not derivable from the code alone.

## What this repo actually is

Despite the name `Pokenic_Game`, this is a **pixel-perfect clone of [phygitals.com](https://www.phygitals.com/)** — a physical/digital trading-card-pack collectibles site — built on top of the AI Website Cloner Template. The page metadata, copy, fonts (Nekst), and assets all target phygitals. When matching "the original," that's the site. Reference specs live in `docs/research/` (`PAGE_TOPOLOGY.md`, `BEHAVIORS.md`, per-component `components/*.spec.md`).

## Running & verifying (read before starting a server)

These are hard-won constraints from `docs/HANDOFF.md`, not preferences:

- **Verify against the production server, not `next dev`.** `next dev` serves images slowly on this machine and makes a correct build *look* broken. Use:
  ```
  npm run build
  npx next start -p 4000   # run in background
  ```
- **Verify with the Playwright scripts in `scripts/*.mjs`, NOT Chrome MCP.** Chrome MCP caused hours of false "still broken" from port/cache confusion. Scripts screenshot to `docs/research/*.png`; read those PNGs back with the Read tool.
- **Watch for runaway node processes** (this has hit thousands of processes / 90+ GB). Check `@(Get-Process node).Count`; kill all with `Get-Process node | Stop-Process -Force`.
- **Worktrees are OK and preferred for isolated feature work** (user adopted the superpowers `using-git-worktrees` skill 2026-06-11 — consent pre-granted): native `EnterWorktree` tool first, else `git worktree add .worktrees/<branch> -b <branch>` (gitignored; verified working). Run `npm install` in fresh worktrees. The old "worktree isolation fails" note applied only to *background-agent* isolation (`worktree.bgIsolation: none` in settings.local.json — leave that as is).

Standard scripts: `npm run dev | build | start | lint | typecheck`, and `npm run check` (lint + typecheck + build). Docker: `docker compose up app --build` (prod) / `dev --build` (port 3001).

## Architecture

**Routes** (`src/app/`, App Router): `/` (home), `/claw`, `/how-it-works`, `/leaderboard`, `/marketplace`, `/pack-party`. The home page (`src/app/page.tsx`) is a thin composition of section components.

**Section composition + scroll-in animation is the core pattern.** `src/app/page.tsx` stacks section components, wrapping most in `<Reveal>` (fade-up on scroll-into-view). The animation engine is:
- `src/lib/use-reveal.ts` — `useInView` (fire-once IntersectionObserver, unobserves after first reveal) + `usePrefersReducedMotion` (SSR-safe).
- `src/components/Reveal.tsx` — wrapper that applies the fade-up and **renders content visible immediately under `prefers-reduced-motion`**.

Sections with their **own** internal scroll animation — `HowItWorksSection` (via `HowItWorksSteps`) and `LeaderboardSection` (staggered row reveal) — are intentionally **not** wrapped in `<Reveal>`. Don't double-wrap them. Any new scroll-triggered behavior should reuse `useInView`/`usePrefersReducedMotion` so reduced-motion stays honored everywhere.

**Server/client split.** Route `page.tsx` files stay server components and export `metadata`; interactivity moves to a sibling `'use client'` component. Canonical example: `marketplace/page.tsx` (server, metadata) → `marketplace/MarketplaceClient.tsx` (client). Follow this when a route needs state.

**Global shell & styling.**
- `src/app/layout.tsx` forces dark mode (`<html className="dark">`) and wraps every page in `SiteHeader` + `SiteFooter`. The palette is hardcoded Tailwind neutrals to match phygitals (`bg-neutral-900`, `text-neutral-50`), **not** the shadcn oklch tokens in `globals.css` (those exist but the clone mostly bypasses them).
- Fonts: **Nekst Black** (self-hosted, `public/fonts/Nekst-Black.woff2`, via `--font-nekst` → `font-heading`) for headings; **Geist** for body.
- **`.px-fluid`** (defined in `globals.css`) is the site-wide horizontal gutter: `clamp(1rem, 1.6vw, 4.5rem)`. The clone is **full-bleed by design — no `max-w-*` caps anywhere** (page, header, footer). Use `px-fluid` on new page/section wrappers instead of breakpoint-stepped padding so layout scales continuously from mobile to 4K.

**UI primitives.** shadcn-style components in `src/components/ui/` built on `@base-ui/react` (not Radix directly). Icons are Lucide. `cn()` from `src/lib/utils.ts` for class merging.

## The clone workflow

Reverse-engineering is measurement-driven, not eyeballed: `scripts/*.mjs` are one-off Playwright capture/measure/QA scripts (e.g. `recon-howitworks.mjs`, `measure-hero*.mjs`, `qa-*.mjs`, `hover-audit*.mjs`) that read computed styles / `getBoundingClientRect` from the live site and the clone, dumping screenshots and JSON into `docs/research/`. Per-component specs (exact computed CSS, states, content, responsive breakpoints) go in `docs/research/components/*.spec.md`; builder sub-agents are dispatched from those spec files.

**`AGENTS.md` is a source-of-truth file that regenerates platform copies — edit it, then run `bash scripts/sync-agent-rules.sh`.** (The clone-website skill and its `sync-skills.mjs` pipeline were removed 2026-06-11.)

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## PM2 services (Radmin-VPN preview stack — keep running until project finish)

| Port | Name | What |
|------|------|------|
| 4000 | pokenic-store | `next start` (prod build — `pm2 restart pokenic-store` after `npm run build`) |
| 4100 | pokenic-store-dev | `next dev` — LIVE-EDIT preview (hot reload on every save; images slow on this machine — never verify against it, :4000 stays the reference) |
| 9000 | pokenic-backend | `medusa develop` (MUST be dev mode: prod marks the admin session cookie Secure → dropped over http → admin login silently fails) |
| 7000 | pokenic-admin | `vite preview --host` of the built dist (backendUrl 26.42.209.183:9000 baked at build) |

`pm2 start ecosystem.config.cjs && pm2 save` (first time) · `pm2 status` / `pm2 logs <name>` /
`pm2 restart all`. Boot persistence: pm2-windows-startup registry entry runs `pm2 resurrect` at
logon; `pokenic-postgres`/`pokenic-redis` have `--restart unless-stopped`. **These PM2 processes
own :4000/:9000/:7000 — don't start ad-hoc servers on those ports; restart the PM2 app instead.**
DB card-image URLs are pinned to the Radmin IP (see the dashboard-vpn memory for the swap-back SQL).
