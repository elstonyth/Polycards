# Production QA fixes — 2026-09-08

Resolves the nine findings from the production functional QA run. No backend
money policy, payment configuration, or account data is changed.

| Finding | Resolution | Regression coverage |
| --- | --- | --- |
| QA-01: conflicting buyback copy | Distinguishes the pack's instant rate during the reveal countdown from 90% vault buyback after leaving or expiry. The RM100 → RM90 example is explicitly a vault example. | All six pack pages; mobile buyback dialog; unchanged backend policy. |
| QA-02: referral prefill lost after reload | Auth modal recovers the normalized invitation from its existing httpOnly cookie through a read-only server action. Stale reads cannot overwrite newer invitations. | Component tests; real referral landing, close, reload, and Join. No signup submitted. |
| QA-03: sidebar selection and URL diverge | Pack rail uses real route links. Quantity changes replace the current URL without adding Back entries; sidebar links carry that quantity. | Component tests; route, heading, quantity, reload, Back, and shared URL browser assertions. |
| QA-04: unsupported fairness claims | Removes commit-reveal and independent-verification claims. Public page states the current secure server draw and that individual proof data is unavailable, including after login. | Source review of selection implementation; rendered public copy. |
| QA-05: missing sprites/favicon | Dex 994/995 use available PNG sprites instead of missing animated URLs. Fallback chains deduplicate URLs and reach the neutral image if PNG loading fails. Adds favicon from the existing app logo. | URL-resolution and actual image-error tests; six guest demos; favicon HTTP 200; no 994/995 GIF requests. |
| QA-06: undersized controls | Enlarges affected help, close, logo, leaderboard, profile, card, account, and cookie controls to at least 44px. | Public control geometry and reflow at 320/390/1440px; account targets require signed-in release verification. |
| QA-07: unclear top-up limits | Shows active minimum/maximum and cent precision. Rejects malformed, out-of-range, and excessive-precision amounts before submission; disables invalid CTA. | 21 component tests across amount validation and gateway behavior. No payment submitted. |
| QA-08: stale wallet gateway copy | Describes the live gateway flow and verification requirements. | Source review; signed-in release verification. |
| QA-09: nested main landmarks | Auth failure and reset-password content use sections inside the app's existing main. | Exactly one main across affected pages and reset states. |

## Verification

- `npm run check`: ESLint, Prettier, TypeScript, Vitest, and optimized webpack build.
- `scripts/qa-referral-navigation.mjs`: guest invitation and navigation regression.
- `scripts/qa-accessibility-fixes.mjs`: 118 public interaction, geometry, and reflow checks.
- `scripts/qa-copy-sprites.mjs`: 16 assertions including all six demo reveal/return flows.
- Browser scripts accept configurable base URLs and output directories for the same
  checks against the standalone build and deployed storefront. Evidence contains
  no authentication tokens or private account details.

## Limits

Independent per-pull proof generation is not implemented by this change. The
fairness fix makes the product's present capability explicit. Paid opens,
deposit settlement, withdrawals, OTP delivery, sell-back, physical delivery,
and second-customer tests still require their respective test access and
transaction authorization; passing guest demos does not validate those paths.
