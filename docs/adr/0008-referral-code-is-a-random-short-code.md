# ADR 0008 — The public referral code is a random short code, not the profile handle

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes (in part)**: the "Attribution" decision in
  `docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` ("the
  referral code is the player handle; no separate code table").

## Context

The 2026-08-24 rebuild made the profile handle (`customer.metadata.handle`,
e.g. `dope-tcg-collectibles-ulbr`) double as the referral identity, shared as
`/invite/<handle>`. Two problems surfaced once the surface was in front of the
operator:

1. The link is long and unreadable aloud, and there was no code a friend could
   type — every recruit had to arrive through the link and its cookie.
2. The handle is printed on every public profile and leaderboard row. Anything
   derived from it is guessable, so a "type the code" field would have let
   anyone attach themselves — or a bot farm — to a stranger's downline just by
   reading the leaderboard.

## Decision

- Each customer gets a **random 8-character code** (32-symbol alphabet with no
  0/O/1/I look-alikes, 40 bits), stored in `customer.metadata.referral_code`
  beside the handle and assigned lazily on the first `/referral` visit
  (`utils/referral-code.ts`, `ensureReferralCode`). No new table: the code is
  looked up the same way the handle is.
- The share link is **`/r/<code>`**; `/referral` shows the QR of that link, the
  link, the code, and a Share button.
- The signup form carries an **optional referral-code field**. A typed code
  wins over the `/r/<code>` cookie; the Google path parks the typed code in the
  same cookie before the OAuth hop.
- A **public** `GET /store/referral/codes/:code` validates a code (display
  fields only, IP rate-limited) so a dead link fails where the visitor can see
  it. `POST /store/referral/bind` takes `referrer_code`. Both hide a disabled
  referrer through one helper (`findBindableReferrer`) so they never disagree.
- Attribution rules are unchanged: bound once at signup, permanent, direct
  only, self-bind refused, admin set/fix by customer id.

## Consequences

- `/invite/<handle>` is gone; links shared before this change no longer
  resolve (pre-launch, no live links existed).
- The storefront treats `code` as optional in the referral payload so a backend
  rollback degrades to "code on its way" rather than a blank page. The bind
  body changed shape (`referrer_handle` → `referrer_code`), so during a skewed
  deploy a bind fails silently and the signup still succeeds — accepted for a
  one-deploy window.
- Uniqueness is a pre-check on an unindexed JSONB scan, like the handle. Move
  both to a keyed table if the customer count ever makes that slow.
