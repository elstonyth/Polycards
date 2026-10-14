# Admin redesign — Phase 2 (Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the operator chose native execution). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the interim Stats landing with the Dashboard at `/overview`. It shows:

- KPI tiles comparing this period with the previous one;
- the net-cash-in headline;
- a money in vs money out chart;
- a "needs your attention" queue;
- a weekly referral commission chart;
- the latest payments.

It is animated, and it uses only existing endpoints.

**Architecture:**

- **Pure data shaping** lives in `src/lib/dashboard.ts`, unit-tested:
  - deltas and tones;
  - settlement gap-fill;
  - referral series;
  - payment merging and status labels;
  - attention summaries.
- **The page** at `src/routes/overview/page.tsx` composes small section components that sit beside it in `src/routes/overview/`. Each section owns its query, loading, error and 401/403-hidden states.
- **Charts** are Recharts 3.10.1, themed with Medusa UI CSS variables, so they follow the operator's light/dark theme.
- **Motion:**
  - a count-up hook;
  - Recharts draw-in;
  - a short panel settle;
  - the attention dot.

  All of it is off under `prefers-reduced-motion`.

**Tech Stack:**

- Vite/React 18 on `@mercurjs/admin` 2.3.3
- `@medusajs/ui`
- TanStack Query (existing hooks)
- Recharts 3.10.1
- Vitest

**Spec:** `docs/superpowers/specs/2026-10-14-admin-redesign-design.md` §7 (Dashboard) and §5 (update: Medusa's original colours).

## Global Constraints

- **Frontend only:**
  - no new endpoints (D1);
  - no data writes;
  - `/admin/economy`, `/admin/payments/balance` and `/admin/payments/audit` are NOT called on the Dashboard.
- **Colours** come from Medusa UI tokens (light and dark), per the spec §5 update. Signal meanings:
  - green (`--tag-green-*`) = money in or good;
  - red (`--fg-error` / `--tag-red-*`) = alert, or a rise in money out;
  - orange (`--tag-orange-*`) = needs action or emphasis.
- **"Top-up" means gateway-settled money only:** the `/admin/stats` and settlement definitions.
- **Strings:**
  - new strings go under the `dashboard.*` key in `en.json`, which core does not own;
  - metric labels reuse `statsBoard.*`, so zhCN keeps working.
- **Navigation:**
  - the Dashboard entry is `pcNav.dashboard`, rank 0, at `/overview`;
  - `/stats` and `/orders` redirect to `/overview`, and the `/orders` handle's `redirectTo` moves to `/overview` too.
- **Mercur skills:** `@medusajs/ui` components (Container, Heading, Text, Badge, StatusBadge, Button), i18n strings, and explicit loading, empty and error states.
- **Commits:** conventional style, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Settlement series with missing periods**, or newest-first rows: the chart must show 12 evenly spaced buckets, oldest to newest, with zeros for the gaps.
2. **A previous-period value of 0:** the delta shows "—", never Infinity or NaN.
3. **Over 50 held withdrawals**, or over 50 pending deposits: counts show "50+" and the RM sum is labelled as covering the first 50.
4. **A role without access to a section's endpoint** (401/403): that section hides and the rest of the page renders.
5. **`prefers-reduced-motion`:** numbers render final immediately, charts don't animate, and no content waits on an animation.

---

### Task 1: Data shaping (`src/lib/dashboard.ts`)

- **Files:** create `backend/apps/admin/src/lib/dashboard.ts` and `src/lib/dashboard.test.ts`.
- **Produces:**
  - `percentChange(cur, prev): number | null`
  - `deltaTone(cur, prev, riseIsBad?): 'good' | 'bad' | 'flat'`
  - `netCashIn(stats): number`
  - `moneyFlowSeries(report, granularity): FlowPoint[]` (FlowPoint = `{ key, label, moneyIn, moneyOut, net }`)
  - `referralSeries(runs, count): RefPoint[]` (RefPoint = `{ key, label, amount }`)
  - `attentionWithdrawals(rows, total)`
  - `staleDeposits(rows, total)`
  - `latestPayments(deposits, withdrawals, n): PaymentRow[]`
  - `paymentStatus(kind, status): { label: string; color: 'green' | 'orange' | 'red' | 'grey' }`
- Steps: write failing tests for each (gap-fill across a sparse newest-first input, zero base, cap at 50, merge order, void runs skipped), watch them fail, implement, watch them pass, commit.

### Task 2: Count-up hook (`src/lib/use-count-up.ts`)

- Pure `countUpAt(from, to, elapsedMs, durationMs)` with ease-out-expo, unit-tested. It is exactly `to` at or after the duration.
- The hook animates with requestAnimationFrame, plus a timeout that sets the final value.
- `usePrefersReducedMotion` returns the final value at once.

### Task 3: Dashboard page and sections

- **Dependency:** add Recharts 3.10.1 to the admin workspace (`corepack yarn workspace @acme/admin add recharts@3.10.1`).
- **Files:** `src/routes/overview/page.tsx` (config: `pcNav.dashboard`, House, rank 0), plus siblings:
  - `RangePicker.tsx` (moved from the Stats page)
  - `KpiTiles.tsx`
  - `MoneyFlowCard.tsx`
  - `AttentionCard.tsx`
  - `ReferralCard.tsx`
  - `LatestPaymentsCard.tsx`
  - `SectionState.tsx` (loading, error with Retry, hidden on 401/403)
- **`en.json`:** `dashboard.*` strings.
- **Motion and section CSS** in `admin-ui.css`, under a `.pc-dashboard` scope:
  - settle keyframes;
  - attention ping;
  - a reduced-motion block.

### Task 4: Retire Stats, repoint the landing

- `stats/page.tsx` becomes a redirect to `/overview`, with no config.
- `orders/page.tsx` sends both `Navigate` and the handle's `redirectTo` to `/overview`.
- Contract test:
  - first group `/overview`;
  - redirects `/orders` and `/stats` → `/overview`.
- QA script:
  - `/`, `/orders` and `/stats` → `/overview`;
  - a Dashboard sections check;
  - screenshots.

### Task 5: Verify and ship

- Run the admin gate: `tsc -b`, `vite build`, `eslint`, `vitest`, and prettier on the changed files.
- Run the Playwright check and read the Dashboard screenshots in light and dark.
- Final review.
- Push the branch and open a PR stacked on #769.
