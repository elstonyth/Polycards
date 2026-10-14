# Admin redesign, phase 3: finance pages and real-customer numbers

Date: 2026-10-14 · Status: approved in chat (mockups in `.superpowers/brainstorm/10496-1791950752/content/`) · Builds on phase 2 (`feat/admin-dashboard-p2`, PR #771).

## 1. Intent

What the operator asked for:

- The Settlement, Transactions, Profit report (Economy) and Players pages look cluttered and use too many words. Redesign them.
- Check whether the Profit report's numbers are accurate.
- In production, the profit figures should count **only real customers**: the Default customer group.

Decisions made in chat:

| Question                                             | Decision                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the real-customer rule applies                 | Profit report **and** Dashboard. Settlement stays all-money because it must match the gateway wallet. Transactions and Players stay full lists, with filters. |
| Can staff still see everyone?                        | Yes. Both pages open on **Real customers**; an **All groups** switch shows everyone, and the page always says which view is on.                               |
| What "profit" means                                  | **Cash view**: money in after fees, minus money out. Then what players could still cash out. Then activity inside the site.                                   |
| Profit report layout                                 | Mockup **A, "Money trail"**                                                                                                                                   |
| Settlement, Transactions, Players, Settlement S$ tab | Approved as mocked                                                                                                                                            |

## 2. Accuracy findings on today's Profit report (`/admin/economy`)

These are the reasons the report is rebuilt instead of restyled.

1. "Net margin" is pack spending minus sell-backs. It ignores top-ups, withdrawals, gateway fees, delivery fees, referral commission and promo credit.
2. "Revenue" is spending volume, not cash. Credit from a sell-back that is spent again counts a second time. Admin credit, daily rewards and referral commission become revenue once they are spent.
3. Sell-backs of promo-origin cards count as payouts, but their opens never counted as revenue.
4. Every account counts: test, generated and grouped accounts included.
5. Vault liability leaves out cards being shipped. "Daily" uses the browser's midnight, not Malaysia time. Top-ups come from ledger rows, so mock top-ups count too. A bad date silently means "all time".

`/admin/economy` itself is **left unchanged**: `desk-reports.spec.ts` checks it against the finance reports, and other readers may rely on its shape. The page moves to a new endpoint.

## 3. Real customer

A customer is a **real customer** when both of these hold:

- they are not in any non-default group. This is the rule `EFFECTIVE_GROUP_SQL` already implements, so customers in no group count as Default;
- they have no `metadata.partner_credential`. Generated accounts can sit in Default; `signupTopupStats` already excludes them by this key.

One SQL helper expresses this: `realCustomerSql(column)` in `modules/packs/real-customers.ts`. Every scoped query uses it.

Known limit, accepted: scope follows **current** membership. Moving a player into another group moves their whole history with them.

The existing `/reports` endpoints keep their own `scopeFilter` unchanged; aligning them is out of scope.

## 4. Profit report

### 4.1 Endpoint: `GET /admin/profit-report`

Query parameters:

- `range`: `today | yesterday | 7d | 30d | month | last_month | custom | all`. Default `month`. Windows come from `statsWindows` (Malaysia time, half-open, with a matching previous window). `all` has no window and no previous.
- `from`, `to`: `YYYY-MM-DD`, for `custom`. A bad range returns **400**; it never silently becomes all-time.
- `scope`: `default | all`. Default `default`. Anything else returns 400.

Response (money in RM, rounded to the sen):

```ts
{
  as_of: string; scope: 'default' | 'all'; range: string;
  window: { from: string; to: string } | null;      // null for 'all'
  previous: { from: string; to: string } | null;
  cash: {
    topups:      { count: number; gross: number; fees: number; missing_fees: number; missing_gross: number };
    withdrawals: { count: number; gross: number; fees: number; missing_fees: number; missing_gross: number };
    fx_earned: number;            // the regional rails' spread, as Settlement's "Conversion earned"
    kept: number;                 // topups.gross − topups.fees − withdrawals.gross − withdrawals.fees + fx_earned
    previous_kept: number | null; // same formula over `previous`
  };
  owed: {                         // a snapshot right now; ignores the window
    wallet_cash: number;          // normal (non-bonus) balance of customers with ≥1 top-up
    wallet_bonus: number;         // bonus balance (shown as a note, never cash)
    wallet_no_topup: number;      // normal balance of customers who never topped up (can't withdraw)
    payouts_in_flight: number;    // payouts pending or held: debited, not paid
    commission_unpaid: number;    // closed weeks' referral commission, not paid yet
    cards: { count: number; delivering: number; sellback: number };  // players with ≥1 top-up
    cards_no_topup: { count: number; sellback: number };             // reported, not owed
    total: number;                // wallet_cash + payouts_in_flight + commission_unpaid + cards.sellback
    all_time_kept: number;        // cash.kept over all time, same scope
    shipped: { count: number; value: number };  // cards delivered, all time, a cost
    if_all_cashed_out: number;    // all_time_kept − total − shipped.value
  };
  activity: {                     // inside the site, over the window
    pack_sales: number; sellbacks: number; promo_given: number;
    delivery_fees: number; referral_commission: number; adjustments: number;
  };
  packs: EconomyPackRow[];        // the existing RTP rows, unchanged math
}
```

### 4.2 Formulas

All three windows (current, previous, all time) come from one scan per table, and the route runs its statements one after the other, so a report load holds one pool connection at a time.

- **Top-ups:** settled `gateway_deposit` rows with `settled_at` in the window.
  - gross = Σ `amount_settled`; a row settled by hand has none and is counted in `missing_gross` (gross is then a floor), never summed as 0;
  - fees = Σ (`amount_settled − net_amount`) over rows whose net and gross are known;
  - `missing_fees` = how many rows have no net (or no gross) yet, so the fee shown is a floor.
- **Withdrawals:** settled `gateway_withdrawal` rows by `settled_at`.
  - gross = Σ `amount`;
  - fees = Σ |`net_amount − COALESCE(amount_settled, amount)`| over rows whose net is known. A payout's net is what we paid, so net ≥ gross (the Settlement direction rule); TGPay rows settled before 2026-09-10 stored it the other way round, and the absolute value reads both right.
- **Regional rails:** the amounts are RM at the customer's locked rate. `fx_earned` adds what the spread earned against the market rate (the same sum as Settlement's "Conversion earned"), so cash kept is real money.
- **Wallets:** per scoped customer, Σ `normalSenSql` and Σ `bonus_cents` over `credit_transaction`.
  - customers with at least one positive `topup` row go into `wallet_cash`;
  - the others go into `wallet_no_topup` (no top-up = no withdrawal or delivery, #748);
  - negative per-customer normal balances count as 0, because nobody is owed a negative amount.
- **Payouts in flight:** scoped `gateway_withdrawal` rows `pending` or `held`. The wallet was debited when the payout was requested, so it appears in neither the wallets nor the withdrawals paid.
- **Commission unpaid:** `weekly_settlement_line` rows still `pending` in a `draft` or `approved` settlement. The open week is worked out when it closes, so it is not counted until then.
- **Cards:** scoped pulls with status `vaulted` or `delivering`. Value = display value (`LIVE_VALUE_USD_SQL` × fx) × `FLAT_PERCENT` (90%), the vault sell-back rate.
  - `delivering` counts at the same basis: a card being shipped is still owed;
  - cards of customers who never topped up are reported in `cards_no_topup`, not owed: they can neither withdraw nor ship;
  - promo-origin cards are included, which is the conservative choice and is stated in the ⓘ hover.
- **Shipped:** scoped pulls `delivered`, all time, at the same basis. They left as goods, so they come off "if all cashed out": completing a delivery never reads as profit.
- **Activity:** `credit_transaction` over the window for scoped customers.
  - pack sales = −Σ normal part of `pack_open`;
  - sell-backs = Σ `buyback` (free and prize cards included);
  - promo given = Σ whole rows of `bonus_grant`, `reward_credit` and `voucher_claim`, plus `daily_reward`;
  - delivery fees = −Σ `delivery_fee`;
  - referral commission = Σ `referral_commission`;
  - adjustments = Σ normal part of `adjustment` (signed: a take-back is negative).
- **Scope caveat:** scope is by the account a row belongs to. In the real-customers view, money moved by other groups' accounts is left out, including referral commission they earned from real customers' play and later withdrew. "All groups" shows it.
- **Pack RTP:** exactly the current `/admin/economy` math, extracted into a shared helper so both routes use one copy.

### 4.3 Page (`/economy`, label "Profit report"): mockup A

1. **Header.** "Profit report", one line saying "Real money in and out, Malaysia time · {window}", the window written as days ("1 Oct – 14 Oct 2026"). On the right, a **Real customers** pill and an **All groups** switch. Below, the Dashboard's period buttons plus **All time**.
2. **Cash kept.** A big figure, coloured by sign and written "− RM x" when negative, with "vs last period" as an RM change (hidden for All time). Below it, a money trail, each row a bar and an amount: Top-ups received, Gateway fees, Withdrawals paid, Exchange spread (only when `fx_earned` ≠ 0), Cash kept.
   - Bars are scaled to top-ups;
   - when money out exceeds top-ups, the bars scale to the larger side and Cash kept shows negative in red;
   - the Gateway fees ⓘ splits top-up fees from payout fees;
   - a "fee is a floor" note appears only when `missing_fees` > 0, and an "estimate" badge sits by the title whenever a fee or gross figure is a floor;
   - on phones the bar moves under its label and amount.
3. **Still owed to players** ("right now" badge). Three tiles:
   - Wallets and payouts due (wallet cash + payouts in flight + unpaid commission), with notes for the in-flight and commission parts and for the bonus and never-topped-up totals left out;
   - Cards in vaults at sell-back, with "N cards, M being shipped" and a note for never-topped-up players' cards left out;
   - Profit if all cashed out (all-time cash kept − still owed − shipped), with the three parts as its note.
4. **Where the money moved.** Six rows: Pack sales, Delivery fees, Sell-backs paid, Promo given, Referral commission paid, Admin adjustments. On a money-out row a payment reads "− RM x" and a take-back "+ RM x". Sell-backs and Promo given carry an ⓘ (free and prize cards).
5. **Pack payout rate.** Pack, price, expected back, and a meter with a mark at 100% plus a badge. The badge is red over 100% and amber from 95%. The table stays sortable.

Wording stays short: one line under each title, and the rest goes in ⓘ tooltips.

## 5. Dashboard: real-customer switch

- `GET /admin/stats` accepts `scope=default|all`, default `all` so old callers keep their answer.
  - `signupTopupStats` and `withdrawalStats` take the scope;
  - top-ups and withdrawals filter `customer_id` with `realCustomerSql`;
  - sign-ups filter the customer itself.
- `GET /admin/payments/settlement` accepts `scope=default|all`, default `all`. `settlementRows` applies the same filter to gateway rows and ledger rows. The Settlement page never sends it.
- The Dashboard header gets the same pill and switch as the Profit report. The KPI tiles, Net cash in and the Money in vs out chart follow it.
- The attention queue, latest payments and referral chart stay all-accounts, because they are operational work. A one-line ⓘ says so.
- Scope lives in the URL (`?scope=all`), so a shared link keeps it. Missing means real customers.

## 6. Settlement (`/settlement`)

The header shows "Settlement · Gateway money, one tab per currency." with pill tabs. The `?currency=` URL stays.

**Gateway strip** replaces RailCard's top half. One card with four or five tiles (two wallets for TGPay, three for A3Pay; wallet tiles appear once the wallet call answers):

- the gateway's name and status badge, with a **Switch gateway…** link;
- the wallet tiles (TGPay: payout and pay-in; A3Pay: available and held), each with an ⓘ for the old hint text;
- **Gateway check**: a ✓ All match or ⚠ N payments differ badge, plus "checked hourly · last 7 days" and the last-run time. The old-gateway history line goes in the ⓘ.

**Switch gateway** opens a **Drawer** with today's radio, reason and confirm flow, unchanged. Warnings and error lines from the balance call stay as short lines under the strip.

**Exchange rate** (regional tabs only):

- title plus the Quoting / Paused / Unavailable badge, and an **Edit rates** button;
- four tiles: Market rate (source · time), Top-up rate, Payout rate, Conversion earned;
- one example line, "S$100 top-up gives RM … credit · RM 100 withdrawal sends S$…";
- **Edit rates** opens a Drawer holding today's whole form (fee switch, both fees, manual rate, reason, live preview, Save and confirm), unchanged in behaviour.

**Results by month/week** has these columns:

| Column       | Shows                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Period       |                                                                                             |
| Money in     | gross, with "N top-ups" beneath                                                             |
| Fees         | deposit fee + payout fee; the split is on hover                                            |
| Money out    | gross, with "N payouts" beneath                                                             |
| Net cash     | in − fees − out                                                                             |
| Ledger check | ✓ matches when the deposit delta is 0; otherwise an amber "RM X gap" with the ⓘ explanation |

- The withdrawal delta is timing-skewed by design, so it is never the check: it shows as a quiet "payouts ±X" line under the gap, explained in the ⓘ.
- Fee-floor and gross-floor notes stay, as one muted footnote line when they apply.

**Gateway audit card** renders only when `findings_total > 0`:

- a warning bar, "N payments the gateway disagrees with · last checked …", with Hide/Show;
- a table with Payment (kind + short reference), Player (linked to the player's page), Our status, Amount and Gateway says;
- rows from a retired gateway (they can never be checked again) are listed but counted apart (`retired_total`), so they never hold up the "payments differ" badge;
- the first 10 rows, then "Show all N"; when the backend's 100-row cap cuts the list, the button and a footnote say "first N of total".

The old "our settled deposits / payouts" totals are dropped; the results table already carries those figures.

## 7. Transactions (`/ledger`)

- **Filter row, one line:**
  - a **Type ▾** select: All, Top-up, Spend, Sell, Order, Adjustment, Challenge, Withdrawal, Referral;
  - a **Date ▾** popover with From and To date inputs plus Clear;
  - search.
- **Backend fix:** `RF` is added to the ledger route's `LEDGER_TYPES`. The Referral filter returns 400 today.
- **Table:**
  - rows are grouped under day headers (Malaysia date);
  - columns are Type (a coloured chip with the display ID in small mono beneath), Player (name with the email beneath), Time, Wallet and Vault;
  - Wallet and Vault are signed, right-aligned and green when positive, with "—" when null or zero;
  - clicking the row toggles the existing payload details, so the chevron column goes;
  - sorting by When and by Type stays, through the header.
- Read-only, as before.

## 8. Players (`/players`)

- **Columns (10):**
  1. Player: initials avatar, name, email beneath;
  2. Phone, with ✓ when verified;
  3. Group chip: Default in grey, others coloured;
  4. Level;
  5. Wallet;
  6. Vault;
  7. Total contribution (top-ups − withdrawals; briefly labelled "Net deposit", renamed back on 2026-10-14 because staff looked for the old name), with an ⓘ that shows the top-up and withdraw totals for that row;
  8. Turnover;
  9. Joined: date, with "Disabled" beneath when disabled;
  10. Status: the enable/disable switch (with its confirm and reason) and the partner badge.
- **Removed from the list** (still on the player's page): Real name, Pulls, Last turnover, and the separate Total top up and Total withdraw columns.
- The same sorts are available where the column survives, plus "Total contribution". A **Sort ▾** select also offers the ones with no column: most topped up, most withdrawn, email A–Z.
- Joined shows "active {ago}" beneath, from the last turnover.
- **Filter:** a **Group ▾** select next to search, with All groups, Default and each other group. The backend `GET /admin/players` gains `group=<id>|default`:
  - a group id filters to that group's members;
  - `default` excludes members of non-default groups.
- **Actions:** **Generate accounts** is the button (there is no separate "Add player" flow); **Export logins** moves into a ⋯ DropdownMenu and toasts when it starts and when the file is ready.

## 9. Visual rules

- Medusa UI components and tokens only, following the operator's light or dark theme.
- One line under each title; explanations go in ⓘ tooltips.
- Money is `tabular-nums` and right-aligned. Signs: green for in, default ink for out, red only for a loss or a problem.
- Mobile: tiles stack, and tables scroll horizontally inside their card.

## 10. Testing

- **Backend:**
  - pure functions (cash kept, owed totals, range and scope parsing) get unit tests;
  - one integration spec seeds a Default customer, a grouped customer and a generated account. It checks that `/admin/profit-report?scope=default` counts only the first and `scope=all` counts all three, and that `/admin/stats` and `/admin/payments/settlement` scope the same way;
  - a ledger route test covers `type=RF`;
  - a players route test covers `group=default` and `group=<id>`.
- **Admin:**
  - vitest for the new pure helpers (money-trail scaling, scope URL param, ledger day grouping, settlement row maths);
  - the existing suite stays green.
- **Playwright QA script:**
  - Profit report in both scopes, plus Dashboard scope;
  - Settlement RM and S$ tabs, including both drawers opening;
  - Transactions with Type = Referral (no error) and the date popover;
  - Players with the group filter and the ⋯ menu;
  - light and dark screenshots, and no page errors.

## 11. Out of scope

- `/admin/economy` and the `/reports` endpoints are unchanged.
- No card buying costs from purchase invoices in profit (could come later).
- Production numbers are not changed. Every query is read-only.

## 12. Player page money (added 2026-10-14)

Staff asked to see, on each player's page, their top-ups today, this week, this month and all time, and whether the house is up or down on them.

- **Endpoint:** `GET /admin/customers/:id/money` (404 for no customer). Read-only, one statement after the other.
  - `periods.{today,d7,month,all}`: top-ups and withdrawals from the credit ledger with the Players list's own sums (`PLAYER_LEDGER_SUMS`), so `contribution` equals that list's "Total contribution". Withdrawals are payout requests net of refunds; a window's count is requests minus refunds, floored at 0. Windows are the Dashboard's `today`, `7d` and `month` presets (MYT, half-open), so "week" is the last 7 days.
  - `last`: the latest top-up, payout request and pack open.
  - `cash`, `owed`, `activity`: the Profit report's §4.2 formulas for this player alone, all time. The report's queries take a `MoneyFilter` (a scope, or one customer as a bound parameter), so both share one copy of the maths.
  - `play`: cards won on the leaderboard's basis (draw-time value × each pull's normal share × today's FX) and `return_pct` = cards won ÷ normal pack spend.
- **Page:** header with avatar, name, badges, email, joined and last active; four tiles (result if they cashed out now, Total contribution, wallet with its bonus, vault at sell-back); the period table; "Where we stand" (the money trail carried on through what they could still take out, down to the result); Play. Gift packs and Bonus credit move into a "Gifts and bonus" tab, reachable from the ⋯ menu. Wallet is the first tab.
- **Checked on prod (read-only, 2026-10-14):** for 11 sampled players the card matched independent SQL and the Players list, ledger and gateway agreed (ledger withdrawals = paid + in flight), and the per-player cash kept summed over all 597 players with gateway money equals the Profit report's all-time kept (scope all) to the sen.
