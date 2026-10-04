# ADR 0009 — The staff desk bots read the admin API through a read-only proxy

- **Status**: Accepted
- **Date**: 2026-10-04
- **Extends**: `docs/superpowers/specs/2026-09-29-desk-reports-design.md`
  (the desk-report keys) and the 2026-10-03 change that let every desk key open
  every `/reports/*` route (#668).

## Context

The five staff Discord desk bots read production through `/reports/<desk>/*`:
curated, read-only slices behind a per-desk `x-report-key`. Anything outside
those slices made a bot ask staff for a screenshot. On 2026-10-04 the Growth
bot asked for a screenshot of the admin challenge queue, which no report
covered. The owner asked for "full access", read-only, for every bot.

## Decision

- **One route, `GET /reports/admin/read?path=/admin/<screen>&<filters>`**, open
  to any desk key, exposed to every bot as the MCP tool `admin_read`. It
  forwards every query parameter except `path` as the screen's own filters.
- **It runs the real admin stack.** The route mints a 60-second JWT for the
  actor `desk-bots-readonly` and calls this same server's admin API on
  `127.0.0.1`, so auth, validators and RBAC all apply. The token never leaves
  the process.
- **Read-only, twice.** The proxy only issues GET. The token carries one role,
  `Desk bots (read-only)`, whose only policy is `*:read` (created on first use
  and looked up on every call, never cached). Core Medusa routes check that
  policy, so they refuse a write even if one were attempted.
- **Blocked screens** (`reports/admin/proxy.ts`, judged in lowercase because
  Medusa matches routes case-insensitively):
  - staff logins and invites;
  - API keys;
  - workflow executions;
  - notifications, which hold reset links;
  - uploads;
  - the two full bank-number reveals (`withdrawals/:id/account`,
    `customers/:id/payout-details`);
  - PriceCharting, where each call costs money;
  - file exports, including the partner-password export.
- **Redacted answers.** Core screens return `customer.metadata` whole, and it
  holds partner account passwords (`partner_credential`) and saved payout banks
  (`bank_accounts`). Before answering, the proxy:
  - replaces any key matching password, secret, token, credential or API key
    with `[hidden]`;
  - cuts any account number to its last 4 digits.
- **Answers are capped** at 40,000 characters, with a note on how to narrow
  the read. Hermes spills anything over 50K into a file the bot cannot read.
- `challenge` and `challenge_poster` take `week=next`, which reads the soonest
  unapplied `challenge_schedule` row, the next week in the admin queue.

## Consequences

- **Staff can now get customer contact details** (name, email, phone, address)
  through any desk bot. That is the owner's choice. Every SOUL says these
  details stay in the staff channel: never in public posts, captions, web
  searches or URLs.
- **Custom admin routes carry no RBAC policies**, so on those routes the
  GET-only proxy is the only thing keeping access read-only. A future custom
  route whose GET has side effects would run for the bots too. Keep GET
  handlers pure. A GET that reveals a secret needs a `BLOCKED` entry, or a key
  name the redaction catches.
- **External lookups.** A few GET routes call outside services
  (`/admin/payments/balance` asks TGPay; `/admin/tcg/card-meta` asks the TCG
  API). Both are cheap reads, so neither is blocked.
- **Revoking access.** To cut one bot off, rotate its desk key
  (`provision-key.mjs <desk>`, then do-apply). To cut every bot off the admin
  API, remove the route. Deleting the role does not work: it is recreated on
  the next read.
