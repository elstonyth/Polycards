# 130 — TGPay sandbox gateway behind a `PAYMENT_GATEWAY` switch

Status: **built and sandbox-verified 2026-09-05** (deposit and payout legs end to end; the payout wallet fault of that morning was fixed on TGPay's side the same day). Production keys applied to the backend 2026-09-06; cutover pending the PR merge and the admin switch.

## Why

The operator is moving the payment gateway from GlobePay365 to TGPay
(sandbox `https://sandbox.tgpay365.com`, API base
`https://sandbox-api.tgpay365.com/api/v2`). Production still runs GlobePay,
so the swap must be a runtime switch, not a rewrite. As built, the ADMIN
setting is the switch — Settlement page → Payment gateway, stored in
`site_settings.payment_gateway` — and `PAYMENT_GATEWAY=tgpay` is only the
boot/fallback value read while that setting is NULL; unset/`globepay` keeps
today's behaviour byte-for-byte. (§"Runtime switch" below has the precedence.)

## What TGPay looks like (read from the sandbox docs, 2026-09-05)

- Auth: `x-public-key` (`pk-…`) + `x-secret-key` (`sk-…`) headers, JSON body
  with `epoch` (unix seconds, ±5 min). No AES, no RSA.
- `POST /transaction/create-payment` → `{status:1, data:{checkoutLink}}`.
  Hosted checkout (no `channelId`): `paymentMethod` `FPX` | `EWALLET` or
  omitted. `checkoutLink` carries `?order=<txn id>`.
- `POST /transaction/query` with `merchantRefNum` → `{data:{order, amount,
fee, amountAfterFee, status:'APPROVED'|'PENDING'|…}}`; payouts return
  `{data:{status, order:{payoutRefNum, merchantRefNum, amount, fee,
amountIncludeFee}}}`. Unknown ref → HTTP 404 `Transaction not found`.
- `POST /transaction/payout/withdraw` needs `email`, `userName`,
  `bankAccNumber`, `bankCode` (SWIFT) + matching `bankName`; sandbox uses the
  pair `DUMMYBANKVERIFIED` / `Dummy Bank Verified`. Returns
  `data.transactionRefNum`.
- Balances: `POST /tenant-credits/balance` (pay-in) and
  `POST /tenant-payout-credits/balance` (payout), body `{epoch, currency}`.
- Payment callback: POST to our `notifyUrl`, same two key headers, body
  `{status, msg, data:{amount, transactionRefNum, merchantRefNum,
paymentMethod, bankName, status:'APPROVED'}}`. At-least-once.
- Payout callback: flat body `{transactionId, status:'pending'|'success'|
'reject', amount, fee, paymentAt, orderno, payType:'PAYOUT'}` — carries NO
  merchantRefNum, so the row is found by `gateway_transaction_id`.
- Errors: 4xx/5xx with `{statusCode, message, error}` or `{message, errors}`.

## Design

Keep every table, model, orchestration file, admin route and reconcile job.
Swap only the HTTP client and the inbound hooks.

1. `modules/packs/tgpay-client.ts` — pure HTTP: config from env
   (`TGPAY_API_BASE`, `TGPAY_PUBLIC_KEY`, `TGPAY_SECRET_KEY`,
   `TGPAY_CURRENCY`), `createPayment`, `queryPayment`, `createPayout`,
   `queryPayout`, `balances`. Throws `TgpayError extends GlobePayError` so
   the orchestration's `definite`/`httpStatus`/`has()` branches keep working
   (`TGPAY_NOT_FOUND` code on 404).
2. `modules/packs/gateway.ts` — the seam. Exports the GlobePay-shaped
   functions (`submitDeposit`, `getDepositDetail`, `submitWithdrawal`,
   `getWithdrawalDetail`, `getSupportedBanks`, `checkBalance`,
   `gatewayConfigFromEnv`, `paymentGateway`) and dispatches on
   `PAYMENT_GATEWAY`. Method mapping for TGPay: `OB`/`FPX` → `FPX`,
   `BQR` → `EWALLET`, `DN` → refused. Bank list for TGPay: the static SWIFT
   table from the docs, plus the dummy bank when the base URL is a sandbox.
3. Orchestration, jobs, admin/store routes import from `./gateway` instead of
   `./globepay-client`. `globepayEnabled()` / `globepayWithdrawalsEnabled()`
   accept the TGPay secret in place of `GLOBEPAY_MERCHANT_CODE` when the
   switch is `tgpay`.
4. New hooks `api/hooks/tgpay/deposit` and `api/hooks/tgpay/withdrawal`:
   timing-safe key-header check, then the same transitions as the GlobePay
   hooks (settle / fail+refund), idempotent.
5. Store deposit/withdraw routes pass the customer's contact
   (name/email/phone) when the switch is `tgpay` — TGPay requires it.
6. Storefront: `NEXT_PUBLIC_PAYMENTS_PROVIDER=tgpay` behaves like
   `globepay` (both are redirect flows).
7. `scripts/check-tgpay.ts` — balance smoke test for credentials/base URL.

## Env (backend, sandbox)

```dotenv
PAYMENT_GATEWAY=tgpay
TGPAY_API_BASE=https://sandbox-api.tgpay365.com/api/v2
TGPAY_PUBLIC_KEY=pk-…            # Platform → Settings → General
TGPAY_SECRET_KEY=sk-…            # needs 2FA on the TGPay account to reveal
GLOBEPAY_ENABLED=true            # master "real gateway" switch, unchanged
GLOBEPAY_NOTIFY_URL=https://<tunnel>/hooks/tgpay/deposit
GLOBEPAY_RETURN_URL=http://localhost:4000/wallet
GLOBEPAY_WITHDRAWALS_ENABLED=true
GLOBEPAY_WITHDRAW_NOTIFY_URL=https://<tunnel>/hooks/tgpay/withdrawal
GLOBEPAY_PAYOUT_VERIFY_URL=unused-by-tgpay   # route only checks presence
```

Local callbacks need a public URL: `cloudflared tunnel --url http://localhost:9000`.
The 1-minute deposit reconcile sweep (query by `merchantRefNum`) is the
fallback when callbacks cannot reach us.

## Out of scope

- Renaming `globepay_*` tables/models/routes. Cosmetic; revisit at cutover.
- Custom-checkout channels (`channelId`) / DuitNow QR. Hosted checkout only.
- Migrating existing saved payout destinations from GlobePay bank codes to
  SWIFT codes — production cutover task.

## Verified 2026-09-05 (sandbox)

- `POST /store/credits/deposit` → TGPay create-payment → absolute link on
  `https://sandbox-checkout.tgpay365.com/checkout?order=…&pm=FPX` (so the
  relative-link fallback never fired; `TGPAY_CHECKOUT_BASE` stays unused).
- Hosted checkout → FPX simulator ("TGPay Bank", dummy login printed on the
  page) → `Approved — 00` → payment callback reached our tunnel within
  ~1 minute → row `settled`, ledger `TP` +RM 50 with the TGPay order id as
  `gateway_ref`, receipt + feed fired once.
- TGPay's own wallet page shows the pay-in as MYR 49.00 (RM 1 FPX fee, the
  1.2 % rate floored at RM 1), Merchant Ref = our `PC-…`, Txn Ref = the
  order id. The audit sweep backfilled `net_amount = 49` from
  `/transaction/query` (`amountAfterFee`); the callback carries no fee.
- Payout: at first `POST /transaction/payout/withdraw` answered
  `400 No payout credit wallet found` (their payout wallet row had no
  currency — a TGPay-side fault, fixed by their CS the same afternoon).
  **Resolved 2026-09-05**: the RM 50 payout probe was accepted and its
  `success` callback settled it; a full customer withdrawal then ran end to
  end (see "Verified" in docs/payments/tgpay-setup.md).

## Source-of-truth additions (same day, user request)

1. Customer id rides on create-payment as `additionalData: Customer <id>`
   (payouts already carry the customer email; TGPay has no free-text field).
2. `jobs/gateway-audit.ts` (hourly): every settled/failed deposit and payout
   from the last 7 days is re-read from the gateway; disagreements land in
   `audit_note` (Migration20260905120000 adds `audited_at`/`audit_note` to
   both tables); `GET /admin/globepay/audit` + a "Gateway audit" panel on the
   admin Settlement page show the live wallet balances beside our all-time
   settled totals and the findings list.
3. `/transactions` shows channel + gateway outcome under each money row's
   reference (`GET /store/credits` gained `transactions[].gateway`).

Jest note: `jest.config.js` runs `loadEnv('test')`, which falls back to the
local env file, so `integration-tests/setup.js` now deletes
`PAYMENT_GATEWAY` before any spec runs.

## Runtime switch (same day, user request: gateways selectable from the admin)

- `GATEWAYS` registry in `modules/packs/gateway.ts` (id, label, `configured(env)`,
  `needsCustomerContact`, hook paths). A new gateway = a client file, a hooks
  folder, the id in the `PaymentGateway` union, a registry entry, an adapter
  in `gateway.ts`, and its bank codes in `banks.ts`. Nothing in the
  orchestration, sweeps, routes or storefront.
- Active gateway = `site_settings.payment_gateway` (admin choice, audited as
  `edit_payment_gateway`) → `PAYMENT_GATEWAY` env → GlobePay. Cached
  in-process, refreshed by `resolveActiveGateway()` at every money entry point
  at most every 30 s; the admin POST flips its own instance at once.
- Every deposit/withdrawal row carries `gateway` (Migration20260905130000,
  existing rows default to GlobePay). Sweeps, the audit and the admin approve
  route use the ROW's gateway (`rowGatewayConfigs` / `rowGateway`), so a switch
  never strands in-flight money on the old gateway. Unconfigured → skipped
  with a log (sweeps) or refused (approve).
- `gatewayUrls()`: with `PAYMENT_CALLBACK_BASE` the notify/verify URLs derive
  from the registry per gateway; without it the explicit `GLOBEPAY_*_URL`
  values apply unchanged (prod safe).
- `GET/POST /admin/payments/gateway`; "Payment gateway" card at the top of the
  admin Settlement page (radio of registered gateways, unconfigured ones
  disabled, reason required, confirm dialog).
- Storefront: `NEXT_PUBLIC_PAYMENTS_PROVIDER` is now just "real gateway vs
  mock" (any value but `mock`); which gateway is the backend's business.
- Verified locally: card renders, a fresh deposit is stamped `gateway=tgpay`
  and redirects to TGPay. Switching TO GlobePay cannot be exercised locally
  (not configured here) — covered by unit tests.

## Bank preservation across gateways (same day, user request)

Saved payout accounts must survive any gateway switch, so nobody re-enters
bank details when gateways two and three arrive.

- `modules/packs/banks.ts`: a gateway-neutral registry of Malaysian banks.
  Canonical id = SWIFT/BIC where TGPay publishes one, else an uppercase slug;
  each entry carries every gateway's own code AND the exact name that gateway
  pairs with it (TGPay validates the pair). Sources: TGPay's SWIFT table (20)
  and GlobePay's live GetSupportedBanks for Testpolycard (31, 2026-09-05).
- Saved accounts and withdrawal rows store the canonical id. The adapters
  translate at payout time (`gatewayBankCode`); a bank the active gateway
  cannot pay to is a definite refusal → refund, never a silent misroute.
- Legacy metadata and rows carry GlobePay's own codes: `findBank` accepts any
  gateway code as an alias, `parseSavedBankAccounts` canonicalises on read
  (recomputing the id, which is derived from the bank code), and the GlobePay
  adapter passes unknown codes through unchanged (they are its own). No
  backfill needed; the next write persists the canonical form.
- The bank picker (`/store/credits/withdraw/banks`) lists the active gateway's
  banks with canonical ids and neutral names; `POST …/accounts` normalises any
  alias and refuses unknown banks. Saved-account views carry `supported` for
  the active gateway; the storefront keeps an unsupported account listed but
  disabled ("not available with the current payout provider").
- Verified on the sandbox: account saved on /bank stored as
  `DUMMYBANKVERIFIED`; a RM 50 customer withdrawal through /bank-withdrawal
  (after clearing playthrough via `scripts/qa-open-pack-api.mjs` + a
  sell-back) was accepted by TGPay and settled by its callback: row
  `settled`, `amount_settled` 50, `net_amount` 49, ledger `WD` −50. Unit
  tests cover the switch both ways (GlobePay code → TGPay SWIFT pair, and
  canonical → GlobePay code).

Jest note: `integration-tests/setup.js` also strips
`PAYOUT_DESTINATION_COOLDOWN_HOURS` and `PAYMENT_CALLBACK_BASE` now.

Second review (2026-09-05, post-bank-preservation) fixed: GlobePay adapter
now refuses a registry-known bank it has no code for (was a pass-through
misroute); an unsupported bank is refused before the debit with the reason;
saved-account views resolve the active gateway first; the admin switch also
requires the payout-verify URL when the gateway has that step; the backfill
script canonicalises row codes; `/bank` shows the not-available state; the
dead `bank_name` validation is gone (the registry supplies the name).

## Callback source allowlist (2026-09-05 evening, TGPay's request)

Both TGPay hooks refuse (403) any source not in `TGPAY_CALLBACK_IPS` when that
env is set; entries are IPv4 or CIDR. The address judged is Express's
`req.ip` (trust proxy 1 → the hop DigitalOcean's balancer appended), never
`X-Forwarded-For`. It is one middleware on `/hooks/tgpay/*`, after the hook
rate limiter. The source is DigitalOcean's `do-connecting-ip` header first
(on App Platform `x-forwarded-for`/`req.ip` are the ingress server, per DO
docs — verified 2026-09-06; the first draft used `req.ip` and would have
refused every production callback), then `req.ip`, then the socket. Fail-closed: a list that is set but yields no entries refuses
everything, and so does production with the list unset — only the sandbox
(base URL containing "sandbox") may run header-only. A mask must be 1–2
digits, so a trailing slash cannot read as `/0`. `.do/backend.app.yaml` now
carries `TGPAY_CALLBACK_IPS` (TGPay's 12 addresses) and
`PAYMENT_CALLBACK_BASE`; only the three TGPAY_* secrets remain for cutover.
Open with TGPay: whether `188.114.96.0` / `188.114.97.0` mean single hosts
or Cloudflare's `/20` — the value accepts CIDR either way.

Production hosts found by probing 2026-09-05 evening: admin
`https://admin.tgpay365.com`, API `https://api.tgpay365.com/api/v2` (answers
the key-headers 401), hosted checkout `https://checkout.tgpay365.com`.
