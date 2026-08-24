# Polycards

The ubiquitous language of the trading-card-pack collectibles platform: gacha
pack opening, a site-credit economy, buyback, a card vault, a VIP
program, and physical delivery. One shared context spans the Next.js storefront
(`src/`) and the Medusa + Mercur backend (`backend/`) — the terms below mean the
same thing on both sides of the wire.

This is a glossary, not a spec. It records what each term _is_, and — where the
codebase uses several words for one idea, or one word for several ideas — which
word is canonical.

## Opening a pack

**Pack**:
A gacha pack listing a customer can open (slug, MYR price, category, buyback
rate, stock). The thing you open.
_Avoid_: product (a Card is backed by a Medusa Product — a Pack is not)

**Card**:
The graded collectible metadata that is a pack's prize — name, set, grader,
grade, USD fair-market value, slab image. Backed by a Medusa Product for
inventory and checkout. A Card carries no Rarity (see Rarity).
_Avoid_: item, prize, product

**PixelPokemon**:
The pixel sprite a Card links to by id. Display art, not a prize on its own.

**PackOdds**:
The gacha table — one row per (Pack, Card) with a relative weight. A card's roll
chance is `weight / Σ(weights in the pack)`. Rarity lives here, per pack, not on
the Card.
_Avoid_: odds, weights (when the row/table entity is meant)

**Open**:
The command that spends credit, rolls PackOdds, and writes a Pull. The paid,
server-side act (`POST /store/packs/[slug]/open`).
_Avoid_: buy, purchase, spin, draw

**Pull**:
The record of one prize acquisition — a pack Open (`source='pack'`), a product
win from a Reward Draw (`source='reward'`), or the one-time Free Welcome Pack
open (`source='free'`). The append-only source of truth for the live-pulls feed,
the leaderboard, and the Vault.
_Avoid_: spin, roll, result

**Free Welcome Pack**:
The one-time free pack a newly registered account may open once (`category=
'free_welcome'` — a reserved category hidden from the catalog like
`reward_box`; storefront entry is the floating badge only). Its Pull has
`source='free'`: excluded from the leaderboard/challenge/feed like `'reward'`,
and LOCKED from Buyback and Delivery until the customer's first paid Open
(computed — any `source='pack'` Pull unlocks it).
_Avoid_: reward (that is the daily VIP draw), demo spin

**Vault**:
A customer's held Pulls — the cards they keep. Not a table: a vault item is a
Pull whose status is `vaulted`.
_Avoid_: inventory, collection, wallet

**Delivery Order**:
A customer's request to physically ship one or more vaulted Pulls, with its own
`requested → processed → ready_to_ship → shipped → completed` status (cancel is
legal pre-ship). A shipment reaching _completed_ (the customer is told
"delivered") is a different fact from a Pull being _delivered_ — do not conflate
the two lifecycles.
_Avoid_: order (a DeliveryOrder is not a Medusa checkout order)

## Two six-name axes — do not conflate

Both use the same six words. They are different measurements.

**Rarity**:
A card's per-pack gacha grade on PackOdds — `Immortal · Legendary · Mythical ·
Rare · Uncommon · Common` (capitalized). Drives the odds weight split and the
tier badge. The same Card can be a different Rarity in a different Pack.
_Avoid_: tier (Tier is the price axis below)

**Tier**:
A card's glow bucket derived from its market value — `common · uncommon · rare ·
mythical · legendary · immortal` (lowercase). Bucketed in MYR bands (`< RM 25` …
`≥ RM 10,000`), and explicitly independent of the card's Rarity.
_Avoid_: rarity (Rarity is the odds axis above); level (Level is VIP)

## Money

All ledger and price money is **MYR** (Ringgit, RM) as a decimal. The single
exception is a card's USD fair-market value, converted to MYR at one pricing
seam.

**FMV** / **Market Value**:
A card's USD fair-market value (from PriceCharting). The only USD in the system.
_Avoid_: price (Price is the MYR sale/pack amount)

**Credit**:
A customer's spendable site balance, in MYR. Held as an append-only ledger
(CreditTransaction); there is no mutable balance column.
_Avoid_: cash, money, wallet, points

**Balance**:
The sum of a customer's CreditTransaction amounts.
_Avoid_: available (Available is the narrower spendable-now figure below)

**External-Funded**:
The portion of a balance or spend backed by real-money top-up, as opposed to
buyback or promo credit. The basis for VIP spend.
_Avoid_: real money, deposited

**Available**:
The spendable balance. Equal to Balance, except that a frozen account reports 0.
(Nothing locks credit any more — the commission lock left with the referral
programme, ADR 0007.)

## Selling and cashing out

**Buyback**:
Selling a Pull back to the house for credit. The Instant rate (the pack's
`buyback_percent`, within the ~30s reveal window) applies at the reveal; the
Flat / Vault rate applies to any later sell from the Vault.
_Avoid_: refund, sellback

**Marketplace Listing** (`for_sale`):
Listing a Card for sale to other users on the marketplace. Distinct from
Buyback (which sells to the house).
_Avoid_: sell (ambiguous between this and Buyback — say which)

**Withdrawal**:
Converting site credit out to real money through the GlobePay365 payout
channel — table `globepay_withdrawal`, route `POST /store/credits/withdraw`,
admin queue `/withdrawals`. The ledger reason string stays `cashout`
(pre-dates the withdrawal build; `credit_transaction` is append-only, so an
existing reason string is never renamed once rows carry it) — say
"Withdrawal" in customer-facing copy and new code, "cashout" only when
naming the literal reason string.
_Avoid_: "withdraw" for the physical reward-shipment flow (`rewards/withdraw`)
— that surface is SUSPENDED (ADR 0004) and its vocabulary does not mean this;
"payout" as a synonym for this action (reserved for the Payout Destination
below, the saved account, not the money-out event)

**Held Withdrawal** / **Approval**:
A Withdrawal above `GLOBEPAY_WD_APPROVAL_ABOVE_RM` (default RM 1,000,
strictly greater-than) is written status `held` — debited from the customer
but never submitted to the gateway — until an admin approves or denies it
from the admin `/withdrawals` queue, whose default view is `held`. Approve
re-checks the customer's freeze state live at click time (the queue's
`frozen` badge is a preview only, not the gate); deny refunds the debit.
_Avoid_: pending (a _different_ status — that row already reached the
gateway and is awaiting its callback)

**Payout Destination**:
A customer's saved bank account for Withdrawals. Adding one starts a
`PAYOUT_DESTINATION_COOLDOWN_HOURS` cooling-off window (default 24h; `0` is
a deliberate, explicit operator opt-out, never the default) before it may be
paid out to — the control on the steal-a-token → add-a-destination →
cash-out chain.
_Avoid_: bank account (fine as plain English inside a definition; Payout
Destination is the domain term when naming the entity)

**Account Deletion**:
Permanent, customer-initiated account removal. Personal data is destroyed
(payout destination account numbers scrubbed to the last 4, holder names
and delivery addresses emptied) while money records — Withdrawal rows,
Delivery Orders, the credit ledger — are retained as anonymous books so the
figures still reconcile. Login becomes impossible forever on the deleted
identity; the same email may re-signup as a new account, but the old one is
never recovered. See ADR 0006.
_Avoid_: deactivate, disable (Account Disable is a separate, reversible
surface — see `disabled-guard.ts` — do not conflate the two)

**Expired Deposit**:
A top-up whose gateway status never resolved within `GLOBEPAY_STALE_AFTER_MS`
(1h, vs GlobePay365's own 10-minute cashier timeout). Non-terminal: the slow
reconciliation sweep keeps re-querying an expired deposit for up to 7 days
rather than writing it off, because "we stopped chasing" is not "the gateway
said no" and a late-landing bank transfer must still be recoverable.
_Avoid_: failed (a genuinely gateway-refused deposit is a different,
terminal status)

## Rewards and VIP

_The reward-granting surfaces below (Reward Box, Reward Draw, Voucher) are
SUSPENDED 2026-07-29 (#294) — storefront routes 404, backend stays live. The
VIP/daily vocabulary is retained because un-suspending is meant to be a revert,
not a rewrite; see ADR 0004. VIP Level accrual itself stayed live throughout._

_The old referral programme was REMOVED outright on 2026-08-24 (ADR 0007) —
engine, tables and vocabulary. Its replacement shipped the same day (spec
`docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md`) with its
own terms, below. The old Commission / Sponsor / Recruit words stay retired._

**Referral Week**:
Tuesday 00:00 MYT to the next Tuesday 00:00 MYT (exclusive) — the window every
weekly payout is computed over. The Tuesday close job snapshots the just-ended
week; Wednesday pays it ("TUES CHECK, WED OUT").

**Referrer / Downline**:
The customer whose invite handle a signup came through, and the set of
customers they referred. Attribution (`referral_attribution`) is one row per
referred customer, bound once at signup, permanent. Direct referrals only — no
generations.

**Referral Commission**:
The referrer's weekly payout: a tier rate (whole-amount, from
`referral_settings.tiers`, admin-editable, default 0.5%→2% by downline weekly
pack turnover) times that same turnover. Paid as straight credit
(`credit_transaction.reason = 'referral_commission'`, ledger type `RF`).

**Partner**:
A customer with a manual commission rate
(`customer_account_state.partner_referral_bp`, bounds admin-configurable,
default 3–5%) that REPLACES the tier table for them. Set on the Customer-360
page; audited.

**VIP Rebate (回水)**:
A customer's own weekly pack turnover times their VIP level's `rebate_bp`
(admin-set on the Levels ladder; 0 by default). Same weekly cycle and ledger
treatment as commission, reason `vip_rebate`.

**Weekly Settlement**:
One `weekly_settlement` run per closed week: draft (Tuesday close) → approved
(human gate on the admin Referrals page) → paid (Wednesday cron or "Pay now").
Lines (`weekly_settlement_line`) are per customer × kind, voidable until paid;
the pay step is idempotent per line via the ledger `(type='RF', ref_id)` index.

**VIP Level**:
A customer's rung 1–100, reached by cumulative pack-open turnover (winnings-funded
opens count too, #254/ADR 0003 — not external-funded spend). Unlocks a Reward Box
tier and avatar frames.
_Avoid_: rank, tier (Tier is the price axis)

**Reward Box**:
The daily free-prize pool attached to a VIP tier.

**Reward Draw**:
A customer's daily free draw from their Reward Box — free, daily-capped,
VIP-gated. Distinct from a pack Open, though a product prize is delivered as a
`source='reward'` Pull.
_Avoid_: spin, open (those are the paid pack flow)

**Voucher**:
A MYR credit grant awarded at a VIP milestone.

**Frame** / **Avatar Frame**:
A cosmetic avatar border unlocked at every tenth VIP level.
_Avoid_: badge, tier, level

## Operator economy

**RTP** (Return-to-Player):
A pack's expected returned value as a percent of its price (`EV / price × 100`).
Above 100 means the operator loses money on that pack.

**EV** (Expected Value):
The odds-weighted expected FMV of one Open of a pack.

## Phone Verification

Phone number confirmation via SMS-delivered OTP (one-time password). When enabled, gates three flows: account signup (requires proof token in header), phone change on existing accounts, and password reset via on-file phone number.

**OTP** (One-Time Password):
4–10 digit code (Twilio's own default is six digits; the check route accepts any length in that range) valid for 10 minutes, sent to the phone via SMS. In dev/test, code is `000000` (overridable via `PHONE_OTP_DEV_CODE` env var). In production, sent via Twilio Verify; production fails closed if Twilio is unconfigured.
_Avoid_: token (that's the proof token below), password (this is a numeric code)

**Proof Token**:
Stateless HMAC-signed token — NOT a JWT: a custom 2-segment `base64url(payload).base64url(hmac)` format, domain-separated from the app's own HS256 JWTs (which share the same `jwtSecret`) via a fixed prefix in the HMAC input. 10-minute TTL, issued after successful OTP check. Single-purpose: proves one phone number for one flow (`signup` | `phone-change` | `password-reset`). Replay within TTL on the same phone is accepted (OTP resend cost is negligible). Different phones produce cryptographically distinct tokens.

**Feature Flags** — two backend env vars, deliberately separate because they have very different blast radii:

- `PHONE_VERIFICATION_REQUIRED` — gates WRITING a phone: signup (`requireSignupPhoneProof`) and phone-change (`blockUnverifiedPhoneWrite`). Affects new signups only; turning it off costs nothing already banked. Also decides whether the `customer.created` subscriber stamps `phone_verified_at` (a phone written while it was off was never proven).
- `PHONE_GATE_REQUIRED` — gates SPENDING and SHIPPING: `requirePhoneVerified` on `POST /store/credits/topup`, `/store/credits/deposit`, `/store/delivery-orders`. Blocks every account without a `customer_account_state.phone_verified_at` stamp — the large majority at cutover. **Unset means "follow `PHONE_VERIFICATION_REQUIRED`"**, so nothing has to be configured for the intended behaviour; it exists so the money path can be reopened in a hurry without also reopening unproven phone writes. Deliberately NOT applied to cancel or any read: an unverified player must still be able to unwind an order and see their own data.

Build-time storefront flag `NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED` displays OTP UI; flag drift is UX-only, backend gates are authoritative. Verification state is visible per player in the admin Players list ("Phone verified" column).

**Outage 2026-08-07 — Twilio 21608, resolved the same day.** Every `POST /Verifications` answered **403** and no customer could receive a code. Nothing in the deployment was at fault: all three `TWILIO_*` secrets were present and authenticating, the Verify service `VA9f…` was owned by the account, and Malaysia (+60) was enabled in SMS geo permissions.

The error was **21608**, whose message mentions only trial accounts — misleading. [Twilio's docs](https://www.twilio.com/docs/api/errors/21608) give it **two** causes, and the second applied: an **upgraded account with no approved primary compliance profile** is restricted exactly like a trial one. The account did start the day as a trial with a negative balance, which masked the real cause — upgrading to paid (`type: Full`, funded) did **not** clear the 403. Fixed by creating a Trust Hub **Individual** primary profile (`BU5c6ce03f…`, `twilio-approved`), after which a live send returned `201 / pending`. An Individual profile needs no business registration and still unlocks international messaging, which is all Verify needs for `+60`; it only limits US A2P 10DLC, toll-free, short codes and alphanumeric senders.

Scope of that proof: the **transport** is confirmed recovered — Twilio accepts a verification and delivers the SMS. The **application** flows (`start` → `check`, then signup / phone-change / password-reset through the storefront) are **PENDING** until the smoke test below is run against the rebuilt storefront with enforcement back on.

Order of diagnosis if OTP breaks again — all three upstream of every flag below:

1. Primary compliance profile approved? (Trust Hub → Compliance profiles)
2. Account `type` and balance — `GET /2010-04-01/Accounts/{sid}.json`
3. Destination country enabled in SMS geo permissions

The failure logs carry Twilio's numeric error code next to the HTTP status, so 21608 (compliance/trial), a geo block and a Fraud Guard hit are distinguishable without a console session.

Both flags went to `false` during the outage, because `PHONE_GATE_REQUIRED` is unset and therefore follows `PHONE_VERIFICATION_REQUIRED`: with a dead SMS transport and enforcement on, every unverified account was frozen out of topup / deposit / delivery and could not verify its way out. Re-armed via the normal Deploy Order (storefront step 3, backend step 4). Interim workaround if it ever recurs: numbers added as **verified caller IDs** are exempt from the restriction — testing only.

**Flows**:

- **Signup**: POST /store/customers with `x-phone-verification` header (proof token) when a phone is provided and feature flag is on.
- **Phone change**: POST /store/phone-verification/change (authed; body {phone, token}) exchanges proof token for verified phone write. POST /store/customers/me rejects string phone writes under enforcement.
- **Password reset**: OTP is sent to on-file phone via POST /store/phone-verification/start (purpose 'password-reset'), exchanged for proof token at POST /store/phone-verification/check, then exchanged for single-use reset token at POST /store/phone-verification/password-reset.

**Rate Limits** (`phone-otp`):
TWO independent tiers per operation, both applied (per-phone runs first):

- **Per-phone** (keyed on the request body's `phone`): the primary per-client fairness / SMS-cost cap. This is the tier that actually protects one caller from another — the storefront's phone-verification server actions proxy every OTP request, so in production every browser's request arrives from the ONE Next.js egress IP.
- **IP** (keyed on the request IP, its designed fallback): a sitewide SMS-spend circuit breaker, sized above legitimate whole-storefront traffic — because of the shared-egress-IP fact above, this tier is a whole-site budget, not per-visitor fairness. Twilio's own Fraud Guard + geo-lock are the upstream defense this tier backstops.

Defaults:

- Start (POST /store/phone-verification/start): per-phone 3 per 10min / 6 per 24h; IP (sitewide) 30 per 60s / 300 per 1h.
- Check (POST /store/phone-verification/check): per-phone 10 per 10min / 30 per 24h; IP (sitewide) 60 per 60s / 600 per 1h.

Tunable via env vars — per-phone: `PHONE_OTP_START_PHONE_RATE_BURST_LIMIT`, `PHONE_OTP_START_PHONE_RATE_BURST_WINDOW_MS`, `PHONE_OTP_START_PHONE_RATE_LIMIT`, `PHONE_OTP_START_PHONE_RATE_WINDOW_MS`, `PHONE_OTP_CHECK_PHONE_RATE_BURST_LIMIT`, `PHONE_OTP_CHECK_PHONE_RATE_BURST_WINDOW_MS`, `PHONE_OTP_CHECK_PHONE_RATE_LIMIT`, `PHONE_OTP_CHECK_PHONE_RATE_WINDOW_MS`; IP: `PHONE_OTP_START_RATE_BURST_LIMIT`, `PHONE_OTP_START_RATE_BURST_WINDOW_MS`, `PHONE_OTP_START_RATE_LIMIT`, `PHONE_OTP_START_RATE_WINDOW_MS`, `PHONE_OTP_CHECK_RATE_BURST_LIMIT`, `PHONE_OTP_CHECK_RATE_BURST_WINDOW_MS`, `PHONE_OTP_CHECK_RATE_LIMIT`, `PHONE_OTP_CHECK_RATE_WINDOW_MS`.

**Accepted Ceilings** (scope boundaries):

- Proof-token replay within 10m TTL on the same phone number (acceptable).
- Legacy non-E.164 phones cannot initiate password reset (only E.164-normalized phones from signup flow work).
- Phoneless direct-API signup unaffected (unchanged pre-existing behavior).
- OTP codes are per-phone, not per-purpose: Twilio re-triggers the SAME code for a number within the 10-minute window regardless of which flow requested it, and POST /store/phone-verification/start is public — so a code phished from a user for one purpose could be checked and exchanged for a proof token under a different purpose. The proof TOKEN itself remains purpose-bound (verifyPhoneProof rejects a mismatched purpose), and every password-reset proof mint still emails the account owner before anything usable comes back. True separation would need one Twilio Verify Service per purpose (three SIDs instead of one) — noted as a hardening option, deliberately not shipped.

**Environment Variables**:
Backend (app-level, like Resend vars): `PHONE_VERIFICATION_REQUIRED` (feature gate, unset/false in dev), `PHONE_OTP_DEV_CODE` (default `000000` for dev/test SMS transport), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` (production Twilio credentials — redacted placeholders live in `.do/backend.app.yaml` as of 2026-08-04, resolved from gitignored `deploy/.env.deploy` by `do-apply.ps1`; the placeholders and that file's values must be added together, since an unresolved token aborts EVERY backend apply). Storefront (build-time inlined): `NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED` (when set to `true`, compiles OTP UI; default false/unset).

**Twilio Operator Checklist**:

1. Create a Twilio Verify Service (Console → Verify → Services): friendly name "Polycards", SMS channel on.
2. Enable Fraud Guard (Verify → Settings, Fraud Guard toggle on) and lock Geo Permissions to expected customer countries only (Malaysia first — SMS-pumping exploits open geo; verify current pricing: per-verification fee + per-SMS rate varies by country, Malaysia cheap).
3. Collect `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` for deployment.

**Deploy Order** (flag-off first, then flip):

Reordered from the original plan (Finding 3, pre-merge review): the original order set the backend enforcement flag in the SAME step as the Twilio secrets — BEFORE the storefront rebuild that ships the OTP UI. Between those two steps every signup that includes a phone number would 400 (`requireSignupPhoneProof` demands a proof-token header the not-yet-rebuilt storefront never sends) — a live signup outage window for however long the two deploys are apart. The fix is to flip the backend enforcement flag LAST, once the storefront is already sending proof tokens.

1. Merge all code changes (Tasks 1–8) and deploy to production with **both flags unset** — zero behavior change, OTP routes and proof logic live but gates are off.
2. At deploy time: add the three Twilio secrets ONLY (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`) to backend DO app spec (app-level, alongside Resend vars) — **do not set `PHONE_VERIFICATION_REQUIRED` yet**. DONE 2026-08-04: the three placeholders are in `.do/backend.app.yaml` and the three names are in `do-apply.ps1`'s required-key list, with real values in `deploy/.env.deploy`. **Placeholders and values move in the same change — an unresolved token aborts every backend apply, not just this feature.** Note: this alone makes POST /store/phone-verification/start a live SMS sender even with the backend flag off (that route isn't flag-gated) — acceptable (it's already rate-limited, see above), but keep this step immediately adjacent to step 3 rather than leaving it live unattended.
3. Set `NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true` in storefront **build environment** and rebuild — build-time-inlined, rebuilds ship the OTP UI. DONE 2026-08-04: root Dockerfile ARG default (the value that actually reaches the bundle — App Platform build-time env is unreliable) + the matching `.do/storefront.app.yaml` env; ships on merge (deploy_on_push). Signup/change/reset now work end-to-end WITHOUT enforcement: the OTP routes and the `x-phone-verification` header plumbing (`src/lib/actions/auth.ts`) aren't flag-gated, only `requireSignupPhoneProof`/`blockUnverifiedPhoneWrite` are — so there is no window where the storefront sends a proof token the backend doesn't yet require, or the reverse.
4. Set backend `PHONE_VERIFICATION_REQUIRED=true` — enforcement turns on. The storefront has been sending proof tokens since step 3, so this step alone flips the gate closed with no outage: unlike the original order, nothing here waits on a storefront rebuild. DONE 2026-08-04: the flag is in `.do/backend.app.yaml`; it goes LIVE on the next `do-apply.ps1 backend`, run only after the step-3 storefront build is ACTIVE.
5. Smoke test production: signup with a real phone number (operator's), phone change, forgot-by-phone flow. Watch backend logs for `[phone-otp]` warnings; monitor Twilio console for delivery success.
6. Rollback levers — pick by what is actually hurting:
   - **Money path only** (topup/deposit/delivery refusing verified-less accounts): set `PHONE_GATE_REQUIRED=false`. Reopens spending and shipping instantly; signup and phone-change stay gated, so nothing unproven gets written while you decide.
   - **Everything**: flip `PHONE_VERIFICATION_REQUIRED` off. With `PHONE_GATE_REQUIRED` unset the money gate follows it, so this still opens every gate in one move — but if `PHONE_GATE_REQUIRED` has been set explicitly, it wins and must be cleared too.
   - Storefront unaffected either way (the OTP UI still works, just no longer required). Flip the storefront flag off + rebuild whenever convenient after that.

## UI only — deliberately not domain

These are presentation words. They must not stand in for the domain terms above.

**Spin**:
Client-side demo theater for logged-out visitors — samples the _published_ odds
and shows a card. No Open, no Pull, no credit, no stock.
_Avoid_: using "spin" for a real Open or Pull

**Reel** / **HReel** / **VaultReel**:
Pure slot-strip geometry and physics primitives that animate the reveal. UI math,
no domain meaning.

**Slab**:
The baked graded-card composite image (frame + photo, one WebP) shown for a
graded Card.
