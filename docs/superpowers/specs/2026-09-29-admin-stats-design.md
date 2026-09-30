# Admin Stats page — design

Date: 2026-09-29
Status: approved (operator, this session)

## Goal

The operators asked for a simple dashboard showing how many people registered
and how many topped up. Their reference was a KPI-card dashboard: preset date
tabs (今天 / 昨天 / 近7天 / 近30天 / 本月 / 上月 / 自定义), and on every card
the value, the % change against the previous period, and the previous value.

## Decisions (operator-confirmed)

1. **Access: a Stats page in the existing admin dashboard.** Admins who can
   already sign in to the dashboard see it in the left menu. There are no new
   accounts, no invite step and no new auth code.
2. **Metrics: the requested set only.** Six cards: 注册人数, 充值笔数, 充值金额,
   充值人数, 首充人数, 首充金额. The reference's withdrawals, active players and
   pack-money figures are out of scope.
3. **Count everyone.** No exclusions for disabled, deleted, test or staff
   accounts. An account deleted later still counts in the period it signed up.
4. **Chinese labels through i18n.** The page's strings get `en.json` keys plus
   a new `zhCN.json`. The page reads in Chinese when a user's dashboard
   language is 简体中文 (Profile → Language).

## Metric definitions

All six come from one SQL statement per window, in a new packs-service method.

| Card                        | Definition                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册人数 signups            | `customer` rows with `has_account = true` and `created_at` in the window. Deleted rows are included, so past periods never shrink.                                                                  |
| 充值笔数 topup_count        | Ledger rows with `reason = 'topup'`, `amount > 0` and `deleted_at IS NULL`, whose `created_at` is in the window.                                                                                    |
| 充值金额 topup_amount       | Σ `amount` of those rows, in MYR, summed in integer cents.                                                                                                                                          |
| 充值人数 topup_customers    | `count(DISTINCT customer_id)` of those rows.                                                                                                                                                        |
| 首充人数 first_topup_count  | Customers whose first-ever top-up falls in the window. "First" is `row_number()` over the customer's whole top-up history, ordered by `(created_at, id)`, and is computed before the window filter. |
| 首充金额 first_topup_amount | Σ of those first top-ups' amounts.                                                                                                                                                                  |

**Why the ledger is the top-up source.** In production, `topup` rows are
written only when a TGPay deposit settles. The mock top-up path refuses to
boot in production when `ALLOW_MOCK_TOPUP` is set, and the prod spec does not
set it. On local data, the settled `gateway_deposit` rows and the non-mock
`topup` rows match one to one, about a second apart. `/admin/economy` already
reads the same rows for its Top-ups figure.

## Windows (MYT, fixed UTC+8)

Malaysia has no DST, so a fixed +8 offset is exact. This is the same
convention as `modules/packs/ledger.ts`. Windows are half-open `[from, to)`,
and the current window's `to` is capped at `now`.

`D0` is today's MYT midnight and `M0` is the MYT midnight on the 1st of this
month.

| Range        | Current                               | Previous                                                |
| ------------ | ------------------------------------- | ------------------------------------------------------- |
| `today`      | `[D0, now)`                           | shifted back 1 day                                      |
| `yesterday`  | `[D0−1d, D0)`                         | shifted back 1 day                                      |
| `7d`         | `[D0−6d, now)`                        | shifted back 7 days                                     |
| `30d`        | `[D0−29d, now)`                       | shifted back 30 days                                    |
| `month`      | `[M0, now)`                           | `[M0−1mo, min(now−1mo, M0))`                            |
| `last_month` | `[M0−1mo, M0)`                        | `[M0−2mo, M0−1mo)`                                      |
| `custom`     | `[from 00:00, min(to+1d 00:00, now))` | shifted back N days, where N is the inclusive day count |

A partial current window is therefore compared with the same span of time one
period earlier. For example, today at 16:07 is compared with yesterday from
00:00 to 16:07.

For `month`, `now−1mo` is the same day and time one calendar month back.
`Date.UTC` overflows a missing day into the next month, and `min(…, M0)`
clamps that back. So on 31 March the previous window is all of February.

## Backend

- `src/modules/packs/stats-window.ts` (new, pure, no Medusa imports). It
  exports `statsWindows(range, now, customFrom?, customTo?)`, which returns
  `{ current, previous }` as `{ from: Date; to: Date }` pairs, or `null` for
  invalid input.
- `PacksModuleService.signupTopupStats(from: Date, to: Date)` (new). It runs
  one raw SQL statement through the module manager, the same way
  `ledgerReasonTotals` does, and returns the six numbers. Money is summed as
  integer cents and returned in MYR.
- `GET /admin/stats` (new: `src/api/admin/stats/route.ts`).
  - Query parameters: `range` (default `today`); `from` and `to` only for
    `custom`.
  - An unknown range, or a custom range with a missing, unparseable, reversed
    or future-start date, returns 400 `INVALID_DATA`.
  - Response: `{ as_of, current: { from, to, stats }, previous: { from, to, stats } }`.
    `from`, `to` and `as_of` are ISO strings.
  - Both windows are queried in parallel.
- `/admin/*` authentication already covers the route. It is GET-only, so the
  admin rate-limit coverage guard, which checks mutations only, needs no entry.

## Admin page

- `apps/admin/src/routes/stats/page.tsx`, with nav label "Stats",
  `ChartBar` icon and `rank: 0`. That puts it in the top group of the custom
  nav: the SDK reads only a numeric literal, so a negative rank would be
  ignored.
- Layout:
  - A row of preset buttons. 自定义 reveals two `<Input type="date">` fields,
    following the ledger page's pattern.
  - Six cards in the Economy page's stat grid (two columns on mobile, three
    on desktop).
  - Each card shows its label and value, then ▲/▼ with the % change against
    the previous window. The arrow is green when the value rose and red when
    it fell. The change shows "—" when the previous value is 0.
  - Each card ends with 上一段 and the previous value.
  - A subtitle states both windows in MYT.
- Data layer: `getStatsReport` in `lib/admin-rest.ts`, a `useStats` hook in
  `lib/queries.ts` with `keepPreviousData`, and a `qk.stats` query key.
- i18n: a `statsBoard.*` namespace in `en.json` and in the new `zhCN.json`,
  registered in `i18n/index.ts`. `statsBoard` does not exist in core, so the
  no-core-shadow test stays green.

## Testing

- Jest unit spec for `statsWindows`:
  - every preset;
  - month clamping (31 March) and the first minute of a month;
  - custom ranges, including one ending today, which caps at `now`;
  - every invalid input.
- HTTP integration spec `integration-tests/http/admin-stats.spec.ts`, using
  the `economy.spec.ts` pattern:
  - 401 without a token;
  - rows are seeded, then backdated with a raw `UPDATE … created_at`;
  - first top-up correctness: a customer whose first top-up is before the
    window is not counted, even though they top up again inside it;
  - the `has_account` filter;
  - the half-open window edges;
  - 400 on a bad range.
- Admin: `yarn build`, `yarn lint`, the i18n tests, and a local page check
  with screenshots.

## Out of scope

- Withdrawals, active players, pack revenue and margin.
- A read-only viewer role.
- Env-driven provisioning of accounts.
- Timed auto-refresh. The dashboard's QueryClient turns refetch-on-focus off
  (`refetchOnWindowFocus: false`, `staleTime` 90s). `useStats` turns it back
  on, so "today" updates whenever the tab regains focus, and that is enough.
