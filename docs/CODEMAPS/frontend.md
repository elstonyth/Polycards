<!-- Generated: 2026-06-08 | Files scanned: src/ | Token estimate: ~900 -->

# Frontend (Next.js 16 App Router, React 19, TS-strict)

Dark-mode-only, full-bleed (no `max-w-*`), Tailwind v4 hardcoded neutrals (not the
shadcn oklch tokens). Nekst Black headings (`font-heading`), Geist body. `.px-fluid`
is the site-wide gutter. 37 routes; commerce/gacha **core** wired, the rest are static clones.

## Core pattern — section composition + scroll reveal
`src/app/page.tsx` stacks section components, most wrapped in `<Reveal>` (fade-up on
scroll-in). Engine: `src/lib/use-reveal.ts` (`useInView` fire-once IntersectionObserver +
SSR-safe `usePrefersReducedMotion`) → `src/components/Reveal.tsx`. `HowItWorksSection` &
`LeaderboardSection` self-animate — **not** wrapped. Reduced-motion renders content immediately.

## Server/client split
Route `page.tsx` = server component (fetch + `export metadata` + `export const dynamic`);
interactivity in a sibling `"use client"` child. Canonical: `marketplace/page.tsx` →
`MarketplaceClient.tsx`; `claw/[slug]/page.tsx` → `PackDetailClient.tsx`.

## Backend-wired routes
```
/marketplace        getMarketplaceCards()   16 house-seller card products (SDK)
/card/[id]          getCardById(handle)     SDK retrieve → mock fallback for non-seeded
/claw               getPackCategories()     /store/packs grouped by category
/claw/[slug]        getPackDetail()+getRecentPulls()  Top Hits + Pull Odds + live feed + Open Pack
(account)/orders    getOrders()             sdk.store.order.list (empty until checkout)
(account)/settings  getCustomer()           profile edit (email read-only)
profile/[user]      MOCK (no public customer endpoint)
```
Other ~30 routes (`/roulette`, `/lucky-draw`, `/repacks`, `/pack-party`, `(account)/*coin`, …)
are **static visual clones** — deferred or excluded by the no-real-money rule.

## Data seam (`src/lib/`) — the only backend touchpoint
```
medusa.ts            sdk = new Medusa({ baseUrl, publishableKey })   singleton
packs-format.ts      RARITIES, isRarity, formatValue                 shared (data + actions)
data/products.ts     getMarketplaceCards · getCardById · getCardHandles      (SDK, USD region)
data/packs.ts        getPackCategories · getPackDetail · getRecentPulls      (sdk.client.fetch)
data/customer.ts     [server-only] getCustomer(cache) · getOrders · updateCustomerProfile
                     · getAuthToken/setAuthToken/clearAuthToken   (httpOnly cookie _pokenic_jwt)
actions/auth.ts      login · signup · logout            (emailpass, server actions)
actions/customer.ts  updateProfile
actions/packs.ts     openPack(slug)                     (Bearer POST → won card)
app/api/me/route.ts  GET → client auth state for AuthProvider
```
All getters try/catch → graceful fallback (empty/mock) so a backend-down build stays green.

## Auth (Phase 3, Option C)
Modal-based (no /login /signup pages): `AuthModal` (global, `pokenic:auth` window event) +
`AuthForm` + `openAuth()` (`AuthButton`) + `AuthProvider`/`useAuth` (context via `/api/me`).
JWT in httpOnly cookie; all Store-API auth runs server-side (browser CORS-blocked at :4000).
`(account)/layout.tsx` gates → redirect `/?auth=login`.

## UI
`src/components/ui/` shadcn-style on **@base-ui** (not Radix); `cn()` from `lib/utils.ts`;
Lucide icons. Verify visually via `scripts/*.mjs` Playwright captures on `:4000` (NOT Chrome MCP).
