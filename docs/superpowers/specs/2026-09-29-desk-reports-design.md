# Desk reports: live production data for the Discord desk bots

**Date:** 2026-09-29 · **Status:** approved in chat by the operator · **Builds on:** the staff Discord desks (5 Hermes bots, set up 2026-09-29), `2026-09-29-marketing-automation-design.md` (its `/marketing/*` feed becomes the `marketing` desk of this system later)

## Problem

Staff ask the desk bots questions that need live production data. On 2026-09-29, Wei Yuan asked the Finance bot for "today's Economy figures counting only DEFAULT-group customers", and the bot could only ask for a screenshot. The operator wants every desk bot to read the data its desk needs from production and answer from real numbers.

## Decisions (locked with the operator, 2026-09-29)

| Question                 | Decision                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How bots read production | The **dashboard's method**: through the backend, which applies the business rules, via read-only report endpoints. No database login, no DigitalOcean CLI, no admin credentials on the PC. Both alternatives were discussed and rejected: they give full-power credentials to a staff-facing bot, open the production database to the owner's PC, and produce numbers that drift from the dashboard. |
| Which desks              | All four: Finance, Store, Support, Growth. Delivered in two phases: **A** = foundation + Finance (the live pain), **B** = Store, Support, Growth.                                                                                                                                                                                                                                                    |
| Privacy                  | No email, phone, address or bank details in any report. Players are identified by their public username (`customer.first_name`, unique case-insensitively).                                                                                                                                                                                                                                          |
| Support web access       | Removed when Support gets order data (prompt-injection exfiltration). Its public policy text is loaded into it directly. Store and Growth keep web; their data is not personal. Finance already has no web.                                                                                                                                                                                          |
| Admin Economy page       | Unchanged for now. The group-scoped query is written so the page can adopt it later.                                                                                                                                                                                                                                                                                                                 |

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
- The report SQL lives beside the routes, in `src/api/reports/`, and reads through the app's shared Postgres connection. The money-path service is not touched.
  - Ledger rows go through the dashboard's own `ledgerTotals` fold.
  - Liabilities come from the same service methods the dashboard uses.
  - An integration test locks `economy` (group `all`) to `/admin/economy`, both all-time and windowed, so the two cannot drift.
  - Money is MYR.

### MCP server: `tools/desk-reports/`

- Node 24, `@modelcontextprotocol/sdk`, stdio. Configured by env: `REPORTS_BASE_URL`, `REPORTS_DESK`, `REPORTS_KEY`. It registers only its desk's tools.
- **Periods** are resolved in **Malaysia time (UTC+8)**:
  - `today`, `yesterday`, `this_week` (Mon–Sun), `last_week`, `this_month`, `last_month`;
  - `last_7_days` and `last_30_days`, which are rolling and match the dashboard's Weekly and Monthly;
  - `all_time`;
  - `custom` with `from`/`to` dates.

  Every answer states the exact window, so staff can compare it with the dashboard.

- The key never reaches the model: Hermes injects it from the profile's `.env` into the server's environment.
- On startup the server writes one line to stderr: `key configured: yes|no (N chars)`. Hermes keeps MCP stderr in a log, so this line proves the `${VAR}` interpolation worked without exposing the key.
- Hermes launches it with the absolute path to `node.exe`, because the gateway's PATH can be minimal.
- All tools carry `readOnlyHint: true`. The Hermes entry sets `trust: full`, because Hermes 0.21.5 cannot see that hint.
  - Its check reads the `readOnlyHint` attribute, but the bundled Python MCP SDK 2.0 names it `read_only_hint`. Every tool therefore counts as write-capable.
  - Under `trust: untrusted`, every report call was denied in a local agent test (2026-10-01). The gateway would ask for approval on each call instead.
  - The boundary that matters is the backend: a desk key opens only `GET /reports/<desk>/*`.
  - Switch back to `untrusted` once Hermes reads the hint correctly. Any write-capable tool added later would then need approval again.
- Installed on the PC under `%LOCALAPPDATA%\hermes\ops\desk-reports`, copied from the repo, so a branch switch in the main checkout cannot break the bots.

### Hermes wiring (per desk)

- `mcp_servers.polycards_<desk>` in the profile's `config.yaml`.
- `REPORT_KEY_<DESK>` in the profile's `.env`.
- `polycards_<desk>` added to `platform_toolsets.discord`.
- A SOUL rule: use the report tools for any live figure, say the window and scope, and never estimate.
- The ops `audit` check uses a per-desk tool allowlist. Only the owning desk may list `polycards_<desk>`, and every other profile must have no `mcp_servers` at all. `hermes -p <profile> tools --summary` confirms this after each restart.

### Deploy and secret order

`scripts/do-apply.ps1` replaces the whole app spec on every apply. A key set only in the DigitalOcean dashboard would therefore vanish at the next apply. The order is:

1. The feature PR carries the `__SECRET__REPORT_KEY_<DESK>__` placeholder (in `.do/backend.app.yaml`) and the key name in `do-apply.ps1`, together.
2. Before merging, generate the key with `tools/desk-reports/provision-key.mjs` into `deploy/.env.deploy` (main checkout) and the desk profile's `.env`. The value is never printed.
3. Merge. The report routes answer 503 until the key is applied, which is the fail-closed state.
4. Apply with `do-apply.ps1` (`-Validate` first).

Steps 2, 3 and 4 each need the operator's explicit OK.

The key goes in before the merge because, once the PR is merged, every `do-apply.ps1 backend` run throws until `deploy/.env.deploy` holds a value for it.

## Phase A: Finance reports

| Route                                           | Returns                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /reports/finance/economy?from&to&group`    | The dashboard's ledger totals (`ledgerTotals`: revenue, payouts, top-ups, adjustments, cashout, delivery fees, referral commission, rewards/promo, net) for `[from, to)`, scoped by player group; plus current vault and voucher liability (all players) |
| `GET /reports/finance/daily?from&to&group`      | The same totals per Malaysia day (range ≤ 93 days)                                                                                                                                                                                                       |
| `GET /reports/finance/payments?from&to&group`   | Deposits and withdrawals in one answer: count, requested and settled sums per status for rows created in the window, plus what is open right now (pending, and held withdrawals)                                                                         |
| `GET /reports/finance/pack-sales?from&to&group` | Opens and net revenue per pack, plus an "unattributed" line for opens that predate `open_id`, so packs sum to economy revenue                                                                                                                            |
| `GET /reports/finance/player?username`          | One player: joined date, group, disabled flag, balance, all-time and last-30-days ledger totals, settled deposits and withdrawals                                                                                                                        |
| `GET /reports/finance/groups`                   | The player groups a `group` scope can name, with how many players each holds now by effective group, plus the DEFAULT count. The live partition check (`tools/desk-reports/live-check.mjs`) uses it                                                      |

**Group scope** (`group` query param):

- `all` (default) applies no filter.
- `default` means players in no non-default group. This follows `effectivePlayerGroup` (`modules/packs/odds-sets.ts`): the oldest non-default group by the group's `created_at`, with `id` as the tiebreak. No group at all counts as DEFAULT.
- Any other value names a group, matched case-insensitively. It means players whose effective group is that group.
- An unknown name answers 400 with the list of valid names.
- Scope uses each player's **current** group, so a player's older rows follow them if they move groups.
- **Partition invariant:** each player has exactly one effective group, where none counts as DEFAULT. So `default` plus the sum over every named group equals `all` for any window. The dashboard has no group filter, so this invariant is the only production-side check that a `default` figure is right.

**Window:** `from` and `to` are ISO instants. The economy route may omit both (all time), like the dashboard. Rows are matched on `credit_transaction.created_at` (payments: the row's `created_at`).

## Phase B: Growth, Store, Support

Rules for every Phase B report (decided 2026-10-01):

- **No player group per row, and no partner labels.** The operator's rule: never point out partner accounts unless staff ask. An aggregate `group` scope is allowed where staff ask for it.
- **No `customer_id` and no `metadata`.** `customer.metadata` holds bank accounts and partner credentials; only `metadata->>'handle'` is safe.
- Every report states its own window.
- **The limiter is keyed by desk plus caller.** All bots share one PC address, so a busy desk must not spend another desk's budget.
- **No live figures from the web tool.** On 2026-10-01 a desk's web tool returned a stale cached copy of polycards.gg. Every desk's SOUL forbids citing Polycards figures read that way.

**Wave 1 (Growth):**

| Route | Returns |
| --- | --- |
| `GET /reports/growth/challenge` | The RUNNING week's public Ranks page challenge board, from the same builder (`src/api/store/challenge/build.ts`). Past weeks are refused: recomputed live they would use today's FX and the promoted ladder, not what settlement paid. Each prize carries its official card image. It returns the challenge week's own bounds, stages (threshold, unlocked, remaining, prizes), `prizes_if_week_ended_now` (settlement's cumulative rule), and the top 10 (shown name, handle, pulls, pulled value). It also returns `hidden_players_above_cut`: while that is above 0, prizes are paid by original rank. |
| `GET /reports/growth/signups?from&to` | New accounts per Malaysia day, counted like the admin Stats page (`signupTopupStats`), plus first top-ups. At most 93 days. |
| `GET /reports/growth/packs?from&to&group` | Paid and free packs opened per Malaysia day, and the 10 most-opened packs (`packOpens`, shared with Finance's pack-sales; opens only). At most 93 days. |
| `GET /reports/growth/challenge-poster?stage&leaders` | A finished 1080-wide JPEG for a post: the unlock headline, stage chips, the featured stage's top-3 prize slabs from their official images (never an AI redraw), optional current leaders, the site address. Unreachable art becomes a placeholder tile. The MCP tool returns it as an image block, which Hermes posts. |

**Wave 2 (planned):**

- **Growth: big pulls.**
  - Sources are `pack` and `free`, at Legendary rarity or above.
  - Disabled players are dropped.
  - Value is the draw value at the live FX rate.
  - The response states this rule.
- **Growth: the week's tasks.** Claims per task, check-ins per day, and unspun free rips.
- **Store:**
  - Packs: price, `in_stock` (a display flag only; a pack shown as sold out can still be opened), set-1 EV/RTP and published EV/RTP.
  - One pack: a pool summary per rarity.
  - Low stock: `on_hand ≤ 0` by default, with untracked cards left out.
  - Never sent: per-card weights, odds sets 2 and 3, `target_rtp_bps` or `cost`.
- **Support:**
  - An order by number: the last 6 characters, or the exact `do_` id.
  - An account by shown name or profile handle.
  - Built from an allowlist of named fields. Every route is tested for no email, phone or address.
  - Support loses the web tool in the same ship.

## Testing

- **Backend:**
  - unit specs for the key guard (503/401/next, one desk's key cannot open another desk), window and group-scope parsing, and the middleware registration;
  - HTTP integration specs covering:
    - the key;
    - group scope, over fixtures that separate the readings: no group; DEFAULT only; Partners only; DEFAULT and Partners; a renamed default group (flag set, other name); a soft-deleted membership; a soft-deleted group;
    - the partition invariant;
    - the `economy` (group `all`) to `/admin/economy` lock, all-time and windowed;
    - Malaysia day buckets;
    - payments by status;
    - pack-sales attribution summing to economy revenue;
    - the player lookup, with no `@` anywhere in the body.
- **MCP server:** `node --test` specs for:
  - period maths (Malaysia boundaries, week starting Monday, month edges);
  - the HTTP client (URL, params, key header, error mapping);
  - a stdio round trip through the SDK client against a fake backend.
- **Live:** after deploy:
  - ask the Finance bot Wei Yuan's question;
  - compare `group=all` with the dashboard for the same window;
  - check the partition invariant for the same window.

## Out of scope

- Any write through the report system.
- Admin dashboard changes.
- The marketing publisher (paused).
