# Admin dashboard redesign ("Vault") — design

Date: 2026-10-14
Status: direction approved in chat (change list, decisions D1–D5, visual direction "Vault"). This written spec is awaiting the operator's review.
Surface: `backend/apps/admin`, the operator dashboard (Vite SPA mounting the prebuilt `@mercurjs/admin` 2.3.3). Product register.
Reference mockup: [`assets/2026-10-14-admin-vault-mockup.html`](assets/2026-10-14-admin-vault-mockup.html) (sample data; open it in a browser).

## 1. Goal

The operators asked for a cleaner admin:

- The sidebar is crowded: about 19 top-level entries, many of them Medusa/Mercur tabs Polycards never uses (Promotions, Reservations, Price Lists, Payouts…).
- Some jobs live in two or three places: three player lists (Players, Customer Support, core Customers), Deposits and the "Topups" tab of All Orders, the exchange rate hidden under "Storefront".
- There is no home page. Logging in lands on Medusa's empty Orders list.
- Much of the wording is internal jargon (FMV, RTP, SP/SE/OD codes, "Held", "Settlement", "Downline").

Success means:

1. The sidebar shows 8 entries, every operator page is at most two clicks from the Dashboard, and no sidebar entry opens an empty or unused page.
2. Each job has one home.
3. Logging in opens a Dashboard that answers "how are we doing, and what is waiting on me" at a glance, with charts and motion.
4. Every custom page uses the plain-language glossary (§9) and the Vault look (§5).
5. Nothing outside the admin frontend changes. Every write action keeps its current API call, confirmation step and audit reason.

## 2. Constraints and non-goals

Constraints:

- **Frontend only.** All changes live in `backend/apps/admin`. No backend routes, migrations, workflows, jobs or environment changes.
- **No production data.** Work is built and verified against the local stack (local backend, local Docker database). Production changes only when a phase's pull request is approved and the admin frontend deploys as usual.
- **Prebuilt shell.** The sidebar and Medusa's own core pages come from the `@mercurjs/admin` bundle. Section 4 lists exactly what can be changed.

Non-goals:

- New metrics or new data. The Dashboard uses only what existing endpoints return.
- Chinese translations for every page. All strings move into `en.json` so Chinese can follow later (D4).
- Fixing the pack editor's "Default odds reset on every visit" behaviour. That needs backend storage.
- Restyling core pages beyond colours and fonts. They inherit the Vault palette through tokens, with no layout or effect changes.
- A light theme. Vault is dark-only.

## 3. Decisions (locked)

| #   | Decision          | Choice                                                                                                                                                  |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Daily chart data  | No new endpoint. Charts use the existing week/month series; KPI tiles compare the current period with the previous one.                                 |
| D2  | Landing page      | The Dashboard. Achieved by overriding the unused core `/orders` list route with a redirect to `/overview`.                                              |
| D3  | Chart library     | Recharts, added to the admin workspace only.                                                                                                            |
| D4  | Language          | English now. Every custom-page string moves into `en.json`. The existing `statsBoard.*` Chinese keeps working on the Dashboard tiles.                   |
| D5  | Unused core pages | All 15 core tabs are hidden from the sidebar. The core Orders list, core Customers list and Reservations also redirect. The rest stay reachable by URL. |
| V   | Visual direction  | "Vault" (§5): matte black, white actions, colour only as a signal, Nekst numbers. **Colours reverted to Medusa's originals on 2026-10-14; see §5.** |

## 4. What can be changed, and how (verified in the 2.3.3 bundle)

- **Core sidebar items** are changed through `src/_navigation.ts` (`defineNavigationConfig` from `@mercurjs/dashboard-sdk`). The Vite plugin finds `_navigation.*` in `src/`, exposes it as `virtual:mercur/navigation`, and `MainSidebar` applies it with `applyNavOverrides`: hide, relabel, re-rank, re-parent. This replaces the CSS hiding rules in `admin-ui.css`.
- **Custom items always render after all core items**, sorted by `rank`. So to put Dashboard first, every core top-level item is hidden and the whole menu is built from our pages.
- **Hiding a core parent hides the custom pages nested under it.** All Orders, Deposits, Withdrawals (under Orders), the Inventory pages (under Inventory), Cards/Packs/Tier Defaults (under Products) and the player pages (under Customers) are re-parented first.
- **Custom pages can nest under custom pages** (`nested: '<custom parent path>'`), which is how the new groups work.
- **A custom route with the same path as a core route replaces it** (`mergeRoutes`). `src/routes/customers/[id]/page.tsx` already does this. A root `src/routes/page.tsx` produces no route (zero path segments), so `/` keeps redirecting to `/orders`; overriding the `/orders` list catches both that and the post-login default (`from ?? "/orders"`).
- **Active state is `pathname.startsWith(to)`.** A nav item at `/` would always look active, so the Dashboard lives at `/overview`. Group-parent paths must not be prefixes of any other route.
- **Core strings:** `customers.domain = "Players"` is the only core translation override allowed (`i18n/no-core-shadow.test.ts`). Labels set in `_navigation.ts` are literal text. Our own pages' labels can use `translationNs` for i18n.
- **Hidden is not deleted.** A hidden page still opens by URL and ⌘K search. No data is removed.
- **Tokens:** Medusa UI colours are CSS variables on `:root` and `.dark` (`--bg-base`, `--bg-subtle`, `--fg-base`, `--border-base`, `--button-inverted`, `--elevation-card-rest`…), and the theme class is driven by `localStorage["medusa_admin_theme"]`. Overriding the variables re-themes core and custom pages alike without touching their markup.
- **Permissions.** RBAC is on.
  - Signed-in humans use the super-admin role (`*:*`); the desk bots use a read-only role (`*:read`, declared in `packages/api/src/policies/desk-bots.ts`).
  - No custom route declares `permissions` today. `RoutePermissionGuard` takes the requirement from the deepest matched route handle that declares one, and honours its `redirectTo`.
  - A custom override of a core path keeps the core handle (handles are merged). So the `/orders` override still requires `order:read`.

## 5. Visual system: Vault

> **Update 2026-10-14 (operator, after seeing Phase 1 live):** keep Medusa's original colours. The Vault colour layer (§5.1 tokens, the pinned dark theme, the hidden theme switch, the active-row and primary-button rules) was removed from Phase 1. What stays: Geist (§5.2), the Settings clean-up, and the signal-colour meanings on custom pages. The colour sections below are kept as the record of what was tried, and as a starting point if the operator wants them back. The Dashboard look (Phase 2) will be re-confirmed against the original colours before it is built.

Polycards' storefront palette, applied to an operator console. Matte black surfaces, white actions, and colour only when it means something: money in, an alert, or something waiting for the operator. The numbers that matter use Nekst Black. Everything else is quiet.

### 5.1 Colour roles

| Role                               | Value                                  | Notes                                                    |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| Page and sidebar                   | `#0a0a0a` / `#0d0d0d`                  | Ink black                                                |
| Panel                              | `#141414`                              | In-flow surfaces                                         |
| Control, raised row                | `#1f1f1f` / `#262626`                  | Inputs, secondary buttons, active nav row                |
| Hairline                           | `rgba(255,255,255,.08)`                | The only border colour                                   |
| Text                               | `#fafafa` / `#a3a3a3` / `#8f8f8f`      | Primary / secondary / meta (meta never for running text) |
| Primary action                     | `#fafafa` button, `#0a0a0a` text       | One per zone                                             |
| Money in                           | `#2fbf6e`, tint `rgba(47,191,110,.12)` | Credited amounts, good deltas                            |
| Alert, destructive, money-out rise | `#f87171`, tint `.12`                  |                                                          |
| Needs action, emphasis             | `#ffb020` (chase gold), tint `.12`     | Attention dot, "Needs approval", current-period bar      |
| Neutral status                     | `#1f1f1f` pill, `#a3a3a3` text         | "Sent to bank", "Draft"                                  |

**How the theme is applied (one approach, no half-light states):**

1. `index.html` pins `localStorage["medusa_admin_theme"] = "dark"` before the app boots, so the `dark` class (and Medusa's `dark:` variants) are always active.
2. The Profile theme switch (`data-testid="sidebar-user-menu-theme-trigger"`) is hidden with CSS, so nobody can pick "Light" in the first place.
3. `admin-ui.css` declares the Vault overrides on **both** `:root` and `.dark`. The pin and the hidden switch make the light class unreachable. Copying Medusa's whole dark block as well (about 170 lines) would only go stale on the next Mercur upgrade, so it was dropped (decided while planning Phase 1).

Indicative mapping:

- `--bg-subtle` → page
- `--bg-base` → panel
- `--bg-component` / `--bg-field` → controls
- `--fg-base` / `--fg-subtle` / `--fg-muted` → the three text steps
- `--border-base` / `--border-strong` → hairlines
- `--button-inverted` → primary action
- `--elevation-card-rest` → a 1px hairline ring with no drop shadow

Danger and tag tokens take Medusa's **dark** values unless contrast fails. The implementation plan carries the full mapping.

Five custom files use raw colour classes or hex values (21 uses). The Phase 1 audit sorted them into two groups:

- **Changed to tokens:** the sprite thumbnails in `pixel-pokemon/page.tsx` and `cards/CardPokemonFields.tsx` sit on `bg-white`, which would show as white squares on the dark base. They move to `bg-ui-bg-component`.
- **Kept on purpose:**
  - the phone and frame previews in `announcements/page.tsx`, `storefront/page.tsx` and `daily-rewards/page.tsx` imitate the storefront's own dark surfaces;
  - the `#FF00FF` values in `storefront/page.tsx` are the magenta-key instructions for the card frame image.

Phase 1 screenshots every custom page and every core Settings page for legibility.

### 5.2 Type

- **UI:** Geist (400/500/600), self-hosted, replacing Inter everywhere, including core pages.
- **Display numbers:** Nekst Black 900, self-hosted (copied from the storefront's `public/fonts/Nekst-Black.woff2`). Used only for the Dashboard headline (46px), KPI values (30px) and page-level money totals. Never in tables, labels or buttons.
- **Scale:** page title 24/600, section title 14/600, body 13–14, labels 12–13. Money uses tabular numerals.

### 5.3 Shape, depth, charts

- Panels 14px radius, controls 10px, pills fully rounded. Hairline borders, no drop shadows on in-flow surfaces. Overlays (modals, drawers, menus) keep Medusa's elevation.
- Charts: money in is a `#2fbf6e` line with an area gradient (30% → 0%); money out is a `#d4d4d4` dashed line. Bars are graphite `#262626`, with the latest bar in chase gold and its value labelled. Gridlines are dashed `rgba(255,255,255,.07)`. Tooltips are graphite with a hairline border. Bars are rounded at the data end only.
- Sidebar: Vault colours and Geist through CSS on the prebuilt sidebar's `data-testid` hooks. The active row is `#1f1f1f` with white text and icon. No badges or counts: the prebuilt nav item can't render them.

### 5.4 Motion

All motion is off under `prefers-reduced-motion`, and no final state depends on an animation finishing (each animation has a timed fallback that sets the end state).

| Element             | Motion                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Numbers             | Count up over 900 ms (ease-out-expo) on load and on range change, starting from the previous value |
| Money chart         | Left-to-right reveal, 1.1 s, on load and on weeks/months switch                                    |
| Bars                | Grow from the baseline over 0.7 s, 35 ms stagger                                                   |
| Dashboard panels    | Settle 8px over 260 ms, total stagger ≤ 0.18 s                                                     |
| Needs-attention dot | Soft 2.4 s ping while the item is open                                                             |
| Hover, toggles      | 150–200 ms                                                                                         |

Table pages get state transitions only (hover, focus, tab change), with no entrance choreography.

### 5.5 Documentation

`DESIGN.md` gains an "Admin console (Vault)" section recording these tokens and rules, so the admin is a documented sub-surface of the brand rather than a parallel system.

## 6. Information architecture

### 6.1 New sidebar

| #   | Entry      | Opens                         | Children (label → path)                                                                                                              | Replaces today                                                                           |
| --- | ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | Dashboard  | `/overview` (new)             | —                                                                                                                                    | Core Orders landing                                                                      |
| 2   | Orders     | `/deliveries`                 | —                                                                                                                                    | Orders › All Orders                                                                      |
| 3   | Payments   | `/payments` → `/withdrawals`  | Withdrawals `/withdrawals` · Deposits `/deposits` · Transactions `/ledger` · Reconciliation `/settlement` · Profit report `/economy` | Orders › Withdrawals, Deposits; Transactions; Settlement; Economy                        |
| 4   | Players    | `/players`                    | Player groups `/odds-sets` · Referrals `/referrals`                                                                                  | Players › Players, Customer Support, Player Groups, Customer Groups; Referrals           |
| 5   | Packs      | `/packs`                      | Cards `/cards` · Pricing `/tier-defaults` · Pokémon sprites `/pixel-pokemon`                                                         | Products › Gacha Packs, Gacha Cards, Tier Defaults; Pixel Pokédex                        |
| 6   | Stock      | `/inventory/list`             | Add stock `/products/from-pricecharting` · Purchase invoices `/purchase-invoices`                                                    | Inventory › Inventory, Add from PriceCharting, Add from PC Collection, Purchase Invoices |
| 7   | Rewards    | `/rewards` → `/daily-rewards` | VIP levels `/daily-rewards` · Tasks `/tasks` · Weekly challenge `/challenge`                                                         | VIP; Tasks; Weekly Challenge                                                             |
| 8   | Storefront | `/site` → `/announcements`    | Announcements `/announcements` · Card frame `/storefront`                                                                            | Announcements; Storefront                                                                |

- All existing page URLs stay the same, so bookmarks keep working.
- **Group parents without a page of their own** (`/payments`, `/rewards`, `/site`) are small redirect pages that carry the sidebar `config` and send the operator to the group's first page. The group then opens with that child highlighted.
- **Parents that are pages themselves** (Players, Packs, Stock) follow the Medusa idiom: the parent link is the main list and the children are related pages.
- Icons come from `@medusajs/icons`, one per entry, never repeated.

### 6.2 Core tabs and redirects

Hidden from the sidebar through `_navigation.ts` (15): Orders, Products, Offers, Collections, Categories, Inventory, Reservations, Customers, Customer Groups, Promotions, Campaigns, Price Lists, Stores, Reviews, Payouts. None is used by Polycards as a page. Players, customer groups and stock data are used, but through our own pages.

Redirect overrides (custom routes replacing the core list page):

| Path                     | Goes to           | Why                                                                                                  |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `/orders` (core list)    | `/overview`       | Landing page (D2); Medusa orders are never created                                                   |
| `/customers` (core list) | `/players`        | Duplicate list; also catches the profile's "Players" breadcrumb                                      |
| `/reservations`          | `/inventory/list` | A reservation made by hand silently lowers gacha stock (`card-stock.ts` subtracts reserved quantity) |
| `/support`               | `/players`        | Page merged into Players (Phase 3)                                                                   |
| `/stats`                 | `/overview`       | Page merged into the Dashboard (Phase 2)                                                             |

- The core "create customer" modal (`/customers/create`) becomes unreachable. Partner accounts are still created from Players.
- Customer Groups stays reachable from each Player groups row ("Members & bulk credit" → `/customer-groups/:id`), the only place the bulk group-credit widget lives.
- **Permissions on the redirects:**
  - The `/orders` override's own route handle declares `{ permissions: "order:read", redirectTo: "/overview" }`. A role without `order:read` is therefore sent to the Dashboard instead of an "access denied" page, and a role with it is redirected by the page itself. Either way, login lands on the Dashboard.
  - The group redirect pages declare no permissions, matching their children, which declare none today. If page-level permissions are ever added, each stub must carry the union of its children's.

### 6.2a In-between state after Phase 1

Phase 1 ships before the Dashboard exists. Until Phase 2:

- the "Dashboard" sidebar entry points at the existing Stats page (`/stats`);
- `/orders` redirects to `/stats`.

Phase 2 adds `/overview`, repoints the entry and both redirects (`/orders` and `/stats`) to it, and retires the Stats page.

### 6.3 Settings and clean-up

- The Settings sidebar can't use `_navigation.ts`. CSS-hide the eight Medusa leftovers there: Tax Regions, Return Reasons, Refund Reasons, Product Types, Product Tags, Attributes, Commissions, Secret API Keys. Keep Users, Sales Channels, Locations, Publishable API Keys, Marketplace and Regions, which the store needs.
- Remove the three main-nav hiding rules from `admin-ui.css` (collections, categories, payouts), now handled by `_navigation.ts`.
- `index.html` title: "Mercur Admin" → "Polycards Admin".

## 7. Dashboard (`/overview`)

### 7.1 Layout

Desktop (main column ≥ 980px). Rows stack below that width.

1. **Header:** greeting ("Good morning / afternoon / evening"), the subtitle "How Polycards is doing · Malaysia time", and the range selector: Today · Yesterday · 7 days · **30 days** (default) · This month · Last month · Custom (two date fields with the Stats page's existing validation).
2. **Row 1:** "Net cash in" headline with the money chart (two thirds) and "Needs your attention" (one third).
3. **Row 2:** four KPI tiles: New players, Top-ups, First-time top-ups, Withdrawals.
4. **Row 3:** "Referral commission per week" (5/12) and "Latest payments" (7/12).

### 7.2 Data (existing endpoints only)

| Section                         | Endpoint                                                                                    | Fields used                                                                                                                                                             | Notes                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline, tiles                 | `GET /admin/stats?range=&from=&to=` (`useStats`)                                            | `current` / `previous`: `signups`, `topup_amount`, `topup_count`, `topup_customers`, `first_topup_count`, `first_topup_amount`, `withdrawal_amount`, `withdrawal_count` | Net cash in = `topup_amount − withdrawal_amount`. A rise in withdrawals is red (the Stats rule). Each tile shows its value, % change, and "this period vs previous" bars. |
| Money chart                     | `GET /admin/payments/settlement?granularity=week\|month&periods=12` (`useSettlementReport`) | `periods[].period`, `deposits.gross`, `withdrawals.gross`                                                                                                               | The series is sparse and newest-first: fill missing periods with 0 and sort ascending. Toggle: 12 weeks / 12 months.                                                      |
| Withdrawals to approve          | `GET /admin/payments/withdrawals?status=held&limit=50`                                      | `total`, row `amount` and `created_at`                                                                                                                                  | Shows count, sum and oldest wait ("50+" when `total` > 50)                                                                                                                |
| Top-ups the gateway hasn't confirmed | `GET /admin/payments/deposits?status=pending&limit=50` (oldest first by default) | rows flagged `stuck: true` | Counts only stuck rows (pending two sweeps past the sweep's stale window, with a gateway id), so a customer who walked away — which the sweep expires — never raises an alarm (changed 2026-10-25; it used `stale` and was read as a gateway fault). Calm, no ping. Shows "50+" at the cap. Links to Deposits › Awaiting payment (`?view=pending`). |
| Orders to ship                  | `GET /admin/delivery-orders?status=…&limit=1` for `requested`, `processed`, `ready_to_ship` | `total` (three calls; the route takes one status)                                                                                                                       | Links to Orders                                                                                                                                                           |
| Referral payout, referral chart | `GET /admin/referrals/settlements`                                                          | runs (≤ 100): `status`, `week_start`, `total_commission_cents`                                                                                                          | Attention item when a `draft` run exists. Chart: last 12 non-void runs, cents ÷ 100, latest highlighted.                                                                  |
| Latest payments | `GET /admin/payments/deposits?status=settled&limit=5` and `/withdrawals?status=all&limit=5`, with an explicit newest-first sort | merged, newest 5 | Both routes default to `pending` and sort pending oldest-first, so `status=all` and the sort are always passed (same format the existing hooks send). Statuses use the glossary labels (§9); a row opens the player's profile. |

Deliberately **not** loaded on the Dashboard: `/admin/economy` (it pages through every card, pack and odds row), and `/admin/payments/balance` and `/admin/payments/audit` (live gateway calls). They stay on Profit report and Reconciliation, which the Dashboard links to.

**One meaning of "top-up" everywhere:** money the payment gateway actually received (the Stats and Settlement definition). The ledger-based figure on Profit report is renamed so it can't be confused (§8).

### 7.3 States and behaviour

- **Loading:** a skeleton per section; numbers count up when data arrives.
- **Errors:** a per-section message with Retry. One failing endpoint never blanks the page.
- **Permissions:** a section whose endpoint answers 401/403 for the signed-in role hides itself instead of showing an error. A read-only role sees the rest of the Dashboard.
- **Empty:**
  - Attention rows appear only when their count is above zero. When everything is clear: "All clear — nothing is waiting on you."
  - Empty period: "No top-ups in this period."
- **Range change:** the previous numbers stay visible while the new ones load (`keepPreviousData`), then count from old to new.
- **Freshness:** tiles and queues follow `useStats` today (refetch on window focus, 90 s stale). The settlement and referral series use a 5-minute stale time.
- **Chinese:** tile labels reuse the existing `statsBoard.*` keys (zhCN exists); new strings live under `dashboard.*` in `en.json`.

## 8. Page changes

### Orders (`/deliveries`)

- Label and heading "Orders" (was "All Orders").
- Remove the "Topups" tab: it is the same list as Payments › Deposits.
- Move "Pack purchases" to Payments › Transactions as its own tab, so it is moved, not lost.
- Status labels: New (requested), Packing (processed), Ready to ship, Shipped, Completed, Cancelled. These are labels only; API values are unchanged.
- The player cell links to the profile.

### Payments

- **Withdrawals:**
  - Tabs replace the dropdown: Needs approval (held, default) · Sent to bank (pending) · Paid (settled) · Refunded · All.
  - Approve, Deny and "Show full number" (was "Reveal") are unchanged in behaviour.
  - The daily withdrawal limit is linked from here; the setting stays where it is (§ Rewards).
- **Deposits:**
  - Tabs: Waiting (default) · Credited · Failed · Expired · All.
  - One word, "Credited", for both the column and the status.
  - "Net" → "After gateway fee". Method codes are shown as names.
- **Transactions (`/ledger`):**
  - Type tabs in full words.
  - Player links to the profile.
  - Details shown as labelled fields instead of raw JSON.
  - New "Pack purchases" tab (moved from Orders).
- **Reconciliation (`/settlement`, was "Settlement"):**
  - Order: gateway balance (once, with a heading) → period table with plain headers → gateway cross-check. Today the balance shows twice.
  - "Switch payment gateway" moves to the bottom in its own warning card, with the same confirmation, reason and live check.
- **Profit report (`/economy`, was "Economy"):**
  - Period presets use the Stats windows in Malaysia time; today they use browser-local and rolling windows.
  - The ledger "Top-ups" tile becomes "Wallet credits (incl. manual)".
  - Tiles that ignore the period are marked "Now".
  - Loading no longer shows "No active packs".

### Players

- **Players (`/players`)** becomes the single player list (Players + Customer Support + core Customers):
  - Default columns, proposed (confirm in review): Player (name, email, @handle), VIP level, Credit balance, Cards held (value), Total top-up, Total withdrawn, Spent on packs, Joined, Status.
  - These leave the table but stay on the profile: phone, real name, phone verified, group, net deposits, last purchase, pull count.
  - Status shows Active, Frozen or Disabled. Today a frozen player shows "Active".
  - "Generate partner accounts" and "Export partner logins" move into a "More" menu.
- **Player profile (`/customers/:id`):**
  - Tabs: Profile · VIP (was "Lvl") · Wallet · Cards (was "Vault") · Orders · Pack opens (was "Pulls") · Gifts & bonus (new; the two panels move off the header, where they show on every tab today) · History.
  - One header "Account" menu holds Freeze/Unfreeze and Disable/Enable, each with a one-line explanation of what it blocks. The wording is checked against the backend during implementation.
  - Fix the Freeze dialog: it currently says "locked out", and its button reads "Apply".
  - Customer Support's two unique pieces move here: the exchange-rate warning banner and the "Sells now for RM X (N%)" column on Pack opens.
    - The quote and the exchange-rate firmness come only from `GET /admin/customers/:id/pulls` (`useCustomerPulls`).
    - The tab's current source, `GET /admin/pulls?customer_id=`, carries rarity but no quote.
    - So the tab adds the second query and joins the two by pull id. Neither endpoint changes.
  - Browser `prompt()` boxes become the reason dialog (§ Shared).
- **Player groups (`/odds-sets`):**
  - A "Members & bulk credit" link on each row.
  - Shorter subtitle.
  - Reason dialog instead of `prompt()`.
  - A note that the withdrawal and phone rules apply only when Partner is on.
- **Referrals:**
  - Weekly payouts first, commission tiers below.
  - Page title added.
  - "Void" → "Cancel" with the reason dialog.
  - Error state with Retry.

### Packs

- **Packs (`/packs`):**
  - Label "Packs".
  - Row actions in a "⋯" menu.
  - "Group" → "Card type"; "Pool & odds" → "Cards & chances".
- **Cards (`/cards`, was "Gacha Cards"):**
  - One name for the action: "Make prize card" (five names today).
  - Columns: "Market price" and "Shop price".
  - Row actions in a "⋯" menu.
- **Pricing (`/tier-defaults`):** rarity price bands plus the exchange-rate card moved from Storefront. Same hooks, same confirmation and reason.
- **Pokémon sprites (`/pixel-pokemon`, was "Pixel Pokédex").**
- **Pack editor (`/packs/:slug`):**
  - Clearer section names.
  - One sticky bar shows which sections have unsaved changes, each marked in place, with that section's own Save button inside the bar. Saves stay per section and call today's endpoints one at a time. There is no combined "save all", because the five saves write real-money odds through different endpoints and a partial failure must never be hidden.

### Stock

- **Stock (`/inventory/list`, was "Inventory"):** "Title" → "Graded?"; "Listing Show" → "Used in"; "In Vault" → "Won, held for players". A negative "On hand" is labelled "Oversold".
- **Add stock:** one sidebar entry. A shared tab header switches between "Search one card" (`/products/from-pricecharting`) and "Import my collection" (`/products/from-pc-collection`).
- **Purchase invoices:**
  - "None" option in the "Undo invoice" picker.
  - "Agent" → "Entered by".
  - "Total FMV" → "Market value (at purchase)".

### Rewards

- **VIP levels (`/daily-rewards`):** tab "Engine settings" → "Withdrawal limit"; "Threshold (RM)" → "Lifetime spend to reach (RM)".
- **Tasks:**
  - Error state with Retry (today it loads forever).
  - Confirmation before Retire.
  - Plain status badges.
  - "Rip" → "Open"; "Cadence" → "Repeats".
- **Weekly challenge:**
  - Fix the two contradictory payout texts.
  - Remove the developer command shown to operators.
  - Reset day becomes a day picker.
  - Confirmation before "Remove from schedule".
  - Search in the prize-card picker.

### Storefront

- **Announcements:** shared page header; the Active switch and Status badge no longer say the same thing twice.
- **Card frame (`/storefront`):** the exchange rate moves to Pricing. Ask for confirmation before saving a new frame, because it redraws every graded card.

### Shared components (Phase 5)

- `PageHeader`: title, one-line description, primary action.
- `StatusBadge`: one map from API status to plain label and Vault colour role (§5.1).
- `ReasonDialog`: replaces every `window.prompt()`, with the same required-reason rules.
- `ErrorState`: message plus Retry for every query, so no infinite skeletons remain.
- `FilterTabs`: replaces the dropdown filters on Deposits and Withdrawals.
- `RowActions` (existing): used wherever a row has three or more buttons.

## 9. Wording glossary (every custom page)

| Area       | Today                                             | New                                                                                              |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Catalog    | FMV                                               | Market price                                                                                     |
| Catalog    | Display price                                     | Shop price                                                                                       |
| Catalog    | markup / margin / multiplier                      | Markup %                                                                                         |
| Catalog    | RTP / EV                                          | Payback % / Avg value per open                                                                   |
| Catalog    | Tier (meaning rarity)                             | Rarity                                                                                           |
| Catalog    | Slab / GRADED / RAW                               | Graded case / Graded / Ungraded                                                                  |
| Catalog    | Handle / Slug                                     | Item code / Web address                                                                          |
| Catalog    | Gacha Cards / Gacha Packs                         | Cards / Packs                                                                                    |
| Catalog    | Pool & odds / pool / win rates                    | Cards & chances / Cards in pack / Pull chances                                                   |
| Catalog    | Lock / Now / Top hit #                            | Set manually / Saved % / Showcase order                                                          |
| Catalog    | balancer                                          | Auto (takes the rest)                                                                            |
| Players    | Turnover / Last turnover                          | Spent on packs / Last purchase                                                                   |
| Players    | Total contribution                                | Net deposits                                                                                     |
| Players    | Lvl / Wallet                                      | VIP level / Credit balance                                                                       |
| Players    | View 360                                          | Open profile                                                                                     |
| Players    | FMV owed                                          | Market value of cards held                                                                       |
| Players    | Pulls                                             | Pack opens                                                                                       |
| Players    | Partner rate                                      | Referral commission %                                                                            |
| Players    | Downline                                          | Invited players                                                                                  |
| Payments   | Held / Pending / Settled (withdrawal)             | Needs approval / Sent to bank / Paid                                                             |
| Payments   | Pending / Settled (deposit)                       | Awaiting payment / Credited                                                                      |
| Payments   | Failed / Expired (deposit)                        | Cancelled / rejected · No gateway answer                                                         |
| Payments   | Stuck (deposit)                                   | Needs gateway check                                                                              |
| Payments   | Reveal                                            | Show full number                                                                                 |
| Payments   | Settlement (page)                                 | Reconciliation                                                                                   |
| Payments   | # / Gross / Fee / Net / Δ                         | Count / Amount / Gateway fee / After fee / Mismatch                                              |
| Payments   | Available / Current / T+1                         | Ready to pay out / Total balance / Clearing tomorrow                                             |
| Payments   | Gateway audit                                     | Gateway cross-check                                                                              |
| Payments   | SP / SE / OD / WP / RF / TP / WD                  | Pack opened / Sold back / Delivery / Challenge prize / Referral commission / Top-up / Withdrawal |
| Payments   | Affect                                            | Balance change                                                                                   |
| Payments   | Economy                                           | Profit report                                                                                    |
| Payments   | Revenue (opens) / Payouts (buybacks) / Net margin | Pack sales / Paid for cards sold back / Pack profit (sales − buybacks)                           |
| Payments   | Vault liability / Adjustments (net)               | Value of cards players hold / Manual balance changes                                             |
| Referrals  | Weekly settlements                                | Weekly commission payouts                                                                        |
| Referrals  | Void run / Void line                              | Cancel payout / Don't pay this line                                                              |
| Referrals  | draft / Basis / Partner rate bounds               | Awaiting review / Spend counted / Allowed partner rate range                                     |
| Stock      | Listing Show / In Vault                           | Used in / Won, held for players                                                                  |
| Stock      | Agent / Total FMV                                 | Entered by / Market value (at purchase)                                                          |
| Stock      | Reverses invoice / weighted-average cost          | Undo invoice / Average cost per card                                                             |
| Rewards    | Engine settings / Threshold (RM)                  | Withdrawal limit / Lifetime spend to reach (RM)                                                  |
| Rewards    | Rip / Cadence                                     | Open / Repeats                                                                                   |
| Orders     | All Orders / Requested / Processed / Canceled     | Orders / New / Packing / Cancelled                                                               |
| Everywhere | MYT                                               | Malaysia time                                                                                    |

Rules:

- Sentence case for labels and badges.
- No raw codes or IDs where a name exists.
- Numbers in RM with thousands separators.
- **Translation keys go in namespaces that don't exist in core** (`dashboard.*`, `ordersPage.*`, never `orders.*`). The core and custom translations are deep-merged, so a custom key on a core path silently replaces Medusa's string. `i18n/no-core-shadow.test.ts` enforces this.

## 10. Delivery plan

One pull request per phase, in order. Each phase ships on its own.

1. **Foundation:**
   - Vault tokens, the pinned dark theme, fonts and sidebar CSS
   - raw colour classes replaced in the five files listed in §5.1
   - `_navigation.ts`
   - the three group redirect pages
   - re-parenting and new labels, icons and ranks
   - redirects: `/customers`, `/reservations`, and `/orders` → `/stats` (the in-between state, §6.2a)
   - Settings leftovers hidden, old nav CSS removed, page title

   This phase alone fixes the crowded sidebar.

2. **Dashboard:** `/overview` with Recharts; the Dashboard entry and the `/orders` and `/stats` redirects point to it; the Stats page is retired.
3. **Merges:**
   - Players + Customer Support
   - Orders tabs
   - Add stock tabs
   - Pricing page
   - Storefront split
   - Reconciliation order
   - Profit report windows
   - Referrals order
4. **Wording:** the §9 glossary, and every hardcoded string moved into `en.json`.
5. **Consistency and fixes:**
   - shared components
   - reason dialog
   - error states
   - confirmations
   - Weekly challenge copy
   - invoice picker
   - pack editor save bar

## 11. Verification

- **Every PR** (`backend/apps/admin`): `corepack yarn build`, `corepack yarn lint`, and `corepack yarn test`, including the no-core-shadow test.
- **Unit tests (Vitest) for new logic:**
  - settlement series gap-fill and ordering
  - net-cash and delta colour rules (a withdrawal rise is red)
  - the status → label map
  - range labels
  - a navigation contract test: every page `config.nested` points at an existing custom parent, and `_navigation.ts` hides exactly the 15 core ids
- **Visual:** Playwright screenshots of the Dashboard and every sidebar entry against the local backend and local database, compared with the mockup. Check at 1280px and 1440px, plus a reduced-motion run.
- **Write paths:** each money and account action is exercised locally (approve/deny withdrawal, credit adjust, freeze, cancel payout, gateway switch, exchange-rate save) to confirm the calls, confirmations and reasons are unchanged.
- **Permissions:** login and the Dashboard are checked locally with a super-admin, with the desk-bot read-only role, and with a throwaway local role lacking `order:read` (it must land on the Dashboard, not "access denied").
- **Theme:** with the Profile theme set to "Light", the admin still renders Vault.
- No production reads or writes at any step.

## 12. Risks

- **Mercur upgrades** can change the sidebar markup (`data-testid` hooks used for styling), `_navigation.ts`, or route-merge behaviour. Re-check on every upgrade; the CSS comments in `admin-ui.css` say so.
- **Token overrides** could leave a rarely used core page low-contrast. Every Settings page is checked in Phase 1.
- **Muscle memory:** labels and places change. A short "what moved where" note for staff goes out with Phase 1.
- **Hidden pages stay reachable by URL.** This is intentional; only the risky ones redirect.
