# Desk reports: live production data for the Discord desk bots

**Date:** 2026-09-29 · **Status:** approved in chat by the operator · **Builds on:** the staff Discord desks (5 Hermes bots, set up 2026-09-29), `2026-09-29-marketing-automation-design.md` (its `/marketing/*` feed becomes the `marketing` desk of this system later)

## Problem

Staff ask the desk bots questions that need live production data. On 2026-09-29, Wei Yuan asked the Finance bot for "today's Economy figures counting only DEFAULT-group customers", and the bot could only ask for a screenshot. The operator wants every desk bot to read the data its desk needs from production and answer from real numbers.

## Decisions (locked with the operator, 2026-09-29)

| Question | Decision |
| --- | --- |
| How bots read production | The **dashboard's method**: through the backend, which applies the business rules, via read-only report endpoints. No database login, no DigitalOcean CLI, no admin credentials on the PC. Both alternatives were discussed and rejected: they give full-power credentials to a staff-facing bot, open the production database to the owner's PC, and produce numbers that drift from the dashboard. |
| Which desks | All four: Finance, Store, Support, Growth. Delivered in two phases: **A** = foundation + Finance (the live pain), **B** = Store, Support, Growth. |
| Privacy | No email, phone, address or bank details in any report. Players are identified by their public username (`customer.first_name`, unique case-insensitively). |
| Support web access | Removed when Support gets order data (prompt-injection exfiltration). Its public policy text is loaded into it directly. Store and Growth keep web; their data is not personal. Finance already has no web. |
| Admin Economy page | Unchanged for now. The group-scoped query is written so the page can adopt it later. |

## Architecture

```
Discord ──► Hermes desk bot (owner's PC)
               │ MCP tool call (e.g. economy(period="today", group="default"))
               ▼
            desk-reports MCP server (Node, stdio, one per desk profile)
               │ HTTPS GET + x-report-key (the desk's key, from the profile's .env)
               ▼
            Polycards backend  /reports/<desk>/*   (admin.polycards.gg)
               │ same service code the dashboard uses
               ▼
            Postgres (production)
```

### Backend: `/reports/<desk>/*`
- One middleware entry for `GET /reports/*`: the `desk-reports` rate limiter (keyed on the caller IP via `callbackSourceIp`), then `requireReportKey()`.
- `requireReportKey()` reads the desk from the path (`/reports/<desk>/…`) and compares `x-report-key` in constant time against `REPORT_KEY_<DESK>` (for example `REPORT_KEY_FINANCE`).
  - An unset key, or one shorter than 32 characters, answers 503.
  - A wrong key answers a bare 401.
  - A desk's key opens only that desk's routes.
  - Every authorised call is logged: desk, path and query.
- Report routes reuse existing service code, so the numbers match the dashboard. Money is MYR.

### MCP server: `tools/desk-reports/`
- Node 24, `@modelcontextprotocol/sdk`, stdio. Configured by env: `REPORTS_BASE_URL`, `REPORTS_DESK`, `REPORTS_KEY`. It registers only its desk's tools.
- **Periods** are resolved in **Malaysia time (UTC+8)**:
  - `today`, `yesterday`, `this_week` (Mon–Sun), `last_week`, `this_month`, `last_month`;
  - `last_7_days` and `last_30_days`, which are rolling and match the dashboard's Weekly and Monthly;
  - `all_time`;
  - `custom` with `from`/`to` dates.

  Every answer states the exact window, so staff can compare it with the dashboard.
- The key never reaches the model: Hermes injects it from the profile's `.env` into the server's environment.
- Installed on the PC under `%LOCALAPPDATA%\hermes\ops\desk-reports`, copied from the repo, so a branch switch in the main checkout cannot break the bots.

### Hermes wiring (per desk)
- `mcp_servers.polycards_<desk>` in the profile's `config.yaml`.
- `REPORT_KEY_<DESK>` in the profile's `.env`.
- `polycards_<desk>` added to `platform_toolsets.discord`.
- A SOUL rule: use the report tools for any live figure, say the window and scope, and never estimate.
- The ops `audit` check allows `polycards_<desk>` tool names.

## Phase A: Finance reports

| Route | Returns |
| --- | --- |
| `GET /reports/finance/economy?from&to&group` | The dashboard's ledger totals (`ledgerTotals`: revenue, payouts, top-ups, adjustments, cashout, delivery fees, referral commission, rewards/promo, net) for `[from, to)`, scoped by player group; plus current vault and voucher liability (all players) |
| `GET /reports/finance/daily?from&to&group` | The same totals per Malaysia day (range ≤ 93 days) |
| `GET /reports/finance/payments?kind=deposits\|withdrawals&from&to&group` | Count, requested and settled sums per status for rows created in the window, plus what is open right now (pending/held) |
| `GET /reports/finance/pack-sales?from&to&group` | Opens and net revenue per pack, plus an "unattributed" line for opens that predate `open_id`, so packs sum to economy revenue |
| `GET /reports/finance/player?username` | One player: joined date, group, disabled flag, balance, all-time and last-30-days ledger totals, settled deposits and withdrawals |

**Group scope** (`group` query param):
- `all` (default) applies no filter.
- `default` means players in no non-default group. This follows `effectivePlayerGroup` (`modules/packs/odds-sets.ts`): the oldest non-default group by the group's `created_at`, with `id` as the tiebreak. No group at all counts as DEFAULT.
- Any other value names a group, matched case-insensitively. It means players whose effective group is that group.
- An unknown name answers 400 with the list of valid names.

**Window:** `from` and `to` are ISO instants. The economy route may omit both (all time), like the dashboard. Rows are matched on `credit_transaction.created_at` (payments: the row's `created_at`).

## Phase B (next plan)
- **Store:**
  - packs: price, stock, sold-out status, odds summary, EV/RTP;
  - cards: stock and display value;
  - low-stock and sold-out lists.
- **Support:**
  - a delivery order's status, items and tracking, by order number;
  - a player's account status by username: active or disabled, phone verified, recent orders.
- **Growth:**
  - sign-ups, packs opened, top packs and big pulls per day or week;
  - Weekly Challenge state;
  - the week's tasks.

## Testing
- **Backend:**
  - unit specs for the key guard (503/401/next, one desk's key cannot open another desk), group-scope parsing and each route's shaping;
  - HTTP integration specs for the key, a group-scoped economy total against seeded ledger rows (a partner-group player excluded under `default`), payments by status, pack-sales attribution, and the player lookup (no email anywhere in the body).
- **MCP server:** vitest specs for period maths (Malaysia boundaries, week starting Monday, month edges) and the request builder (URL, params, key header).
- **Live:** after deploy, ask the Finance bot Wei Yuan's question and compare it with the dashboard for the same window.

## Out of scope
- Any write through the report system.
- Admin dashboard changes.
- Phase B routes (next plan).
- The marketing publisher (paused).
