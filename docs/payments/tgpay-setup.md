# TGPay payment gateway — setup notes

Status: **sandbox integration built 2026-09-05 (plan 130)**, behind the
`PAYMENT_GATEWAY=tgpay` switch. Production stays on GlobePay365 until the
switch is flipped there.

Source: the sandbox admin's own docs — <https://sandbox.tgpay365.com/docs/api>
and `/docs/sandbox-api` (login required). Their doc template leaves the base
URLs blank; the values below were confirmed by probing.

## Environments

|                 | Sandbox                                                                            | Production                 |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| Admin           | <https://sandbox.tgpay365.com/>                                                    | <https://admin.tgpay365.com/> (probed; login pending) |
| API base        | `https://sandbox-api.tgpay365.com/api/v2`                                          | `https://api.tgpay365.com/api/v2` (probed: key-headers 401) |
| Hosted checkout | `https://sandbox-checkout.tgpay365.com/checkout?order=…` (absolute link, verified) | `https://checkout.tgpay365.com` (probed) |

`/api/v1` is a 404 on the sandbox; `/api/v2` answers. Without key headers the
API returns `401 x-public-key and x-secret-key headers are required`, which is
the cheapest connectivity probe.

## Wire format

- Headers `x-public-key` (`pk-…`) and `x-secret-key` (`sk-…`) on every call.
  No AES, no RSA. The **same two headers authenticate their callbacks to us**.
- JSON body with `epoch` = unix seconds; rejected outside ±5 minutes
  (`400 Request epoch is expired`). Keep the server clock synced.
- Amounts in **major units** (`10` = RM 10.00), up to 2 dp.
- Success is HTTP 200 + `{ status: 1, msg, data }`; errors are 4xx/5xx with
  `{ statusCode, message, error }` or `{ message, errors }`.

| Call                   | Endpoint                              | Notes                                                                                |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Create payment         | `POST /transaction/create-payment`    | returns only `data.checkoutLink`; the `order` query param is their txn id            |
| Query payment / payout | `POST /transaction/query`             | by `merchantRefNum`; unknown → `404 Transaction not found`                           |
| Create payout          | `POST /transaction/payout/withdraw`   | needs `email`, `userName`, `bankAccNumber`, `bankCode` (SWIFT) + matching `bankName` |
| Pay-in balance         | `POST /tenant-credits/balance`        | `{ epoch, currency }`                                                                |
| Payout balance         | `POST /tenant-payout-credits/balance` | separate wallet                                                                      |

Callbacks: payment notify is `{ status, msg, data: { amount, transactionRefNum,
merchantRefNum, paymentMethod, bankName, status: 'APPROVED' } }`; payout notify
is a **flat** `{ transactionId, status: 'pending'|'success'|'reject', amount,
fee, paymentAt, orderno, payType }` with **no merchantRefNum** — the row is
found by the `transactionRefNum` stored at create time. Both are at-least-once.

## What the code does

- `modules/packs/tgpay-client.ts` — HTTP client, error class (`TgpayError`
  extends `GlobePayError`, `definite` = parseable 4xx), status mapping, the
  SWIFT bank table, callback header check (constant-time).
- `modules/packs/gateway.ts` — the switch. GlobePay-shaped functions, so the
  deposit/withdrawal orchestration, reconcile sweeps and admin routes did not
  change. Storefront method codes map `OB`/`FPX` → hosted FPX, `BQR` → hosted
  E-wallet; `DN` is refused (DuitNow QR needs custom checkout).
- `api/hooks/tgpay/deposit` and `api/hooks/tgpay/withdrawal` — the callbacks.
- `scripts/check-tgpay.ts` — balance preflight; `scripts/tgpay-payout-probe.ts`
  — sandbox-only RM 50 payout to the dummy bank, outside our ledger;
  `scripts/run-gateway-audit.ts` — run the audit sweep once.
- `jobs/gateway-audit.ts` + `GET /admin/globepay/audit` — the gateway-as-
  source-of-truth check (plan 130 §additions); findings on the admin
  Settlement page.

Rows still live in `globepay_deposit` / `globepay_withdrawal`; `gateway_status`
is `null` for TGPay rows (their statuses are strings, the column is numeric).

## Sandbox facts (read from the admin 2026-09-05)

- Tenant `polycards`, currency MYR. Rates: DuitNow 1.5 %, FPX 1.2 % (min RM 1),
  e-wallet 1.6 %; payout 0.6 % (min RM 1), **payout RM 50 – RM 30,000 per
  request**; settlement withdrawal min RM 3,000, fixed fee RM 10.
- Keys: Platform → Settings → General → API keys. The public key reveals
  without 2FA; **the secret key needs 2FA enabled on the account** (per TGPay
  CS, 2026-09-05).
- Sandbox custom-checkout channel ids: `SANDBOX_BANK_FPX_MY`,
  `SANDBOX_TNG_EWALLET_MY`, `SANDBOX_DUITNOW_DUITNOWQR_MY` (not used — we use
  hosted checkout).
- Sandbox payout bank: `DUMMYBANKVERIFIED` / `Dummy Bank Verified`, e.g.
  account `543478924652`, name `Michael Yap`. The bank picker lists it first
  whenever `TGPAY_API_BASE` contains "sandbox".

## Production tenant (read 2026-09-06, logged in as `polycards`)

- Back office `https://admin.tgpay365.com` (the sandbox login works there);
  API `https://api.tgpay365.com/api/v2` (the admin itself calls it); hosted
  checkout `https://checkout.tgpay365.com`.
- **API keys are gated on 2FA**: the reveal buttons open "Two-factor
  authentication required — set it up first" (Settings → Two-factor
  authentication). Keys are not issued until then. Once 2FA is on, each
  reveal asks for an emailed code ("Skip verification for 5 minutes" covers
  both keys). **The production keys are short opaque strings** (10 and 8
  characters, one of them digit-only), not the sandbox's 51-character
  `pk-`/`sk-` pair — the client never checks a prefix, and the spec quotes
  the placeholders so a digit-only value stays a YAML string.
- **Their API is IP-allowlisted per tenant**: from a workstation
  `check-tgpay` gets `403 Request IP is not allowed for this tenant`, so the
  keys can only be proven from the DO egress IPs (run the preflight through
  `scripts/do-exec.mjs` after the apply, or watch the first switch attempt).
- Keys live in the gitignored deploy secrets file (`TGPAY_PUBLIC_KEY`,
  `TGPAY_SECRET_KEY`); `scripts/do-apply.ps1 backend` injects them with
  `TGPAY_API_BASE=https://api.tgpay365.com/api/v2` (2026-09-06).
- Currency shows "—" (unset), tenant credit and payout credit 0.00 — ask
  TGPay to set MYR and fund the payout wallet before go-live (same trap as
  the sandbox's currency-less payout wallet).
- Bands differ from the sandbox: FPX / e-wallet / DuitNow **RM 50 – 30,000**
  per transaction (sandbox had no RM 50 floor); payout RM 50 – 30,000. The
  registry carries these per gateway (`GATEWAYS.tgpay.limits`) and the
  storefront reads them from `GET /store/payments/config` when the sheet
  opens, so a switch never offers a floor the gateway refuses.
- Settlement to us: fixed RM 10 fee, minimum RM 3,000; owner name / ID /
  bank fields are empty — fill them so pay-in balance can be settled out.

## Which gateway is active

An admin setting, not an env var: Settlement page → **Payment gateway**
(`GET/POST /admin/payments/gateway`, audited). `PAYMENT_GATEWAY` is only the
boot/fallback value. Set `PAYMENT_CALLBACK_BASE` (the backend's public origin)
so the notify URLs derive from each gateway's hook paths; without it an
explicit `GLOBEPAY_*_URL` is honoured only when it already names that
gateway's hook, and the switch refuses a gateway with no callback URL. Every
deposit/withdrawal row records its gateway, and the sweeps use the row's.

## Bank accounts survive a switch

Saved payout accounts store a gateway-neutral bank id (`modules/packs/banks.ts`,
SWIFT where TGPay has one); each adapter translates to its own code at payout
time. Legacy GlobePay codes are read as aliases, so nothing needs re-entering.
An account whose bank the active gateway cannot pay to stays listed but
disabled on the storefront until a gateway that serves it is active.

## Local test loop

1. Backend `.env`: the TGPay block (see `.env.template`). Callbacks need a
   public URL — `cloudflared tunnel --url http://localhost:9000` prints one;
   put it in the two NOTIFY vars. The 1-minute deposit sweep
   (`jobs/globepay-reconcile.ts`, query by `merchantRefNum`) is the fallback
   when a callback cannot reach us.
2. Storefront `.env.local`: `NEXT_PUBLIC_PAYMENTS_PROVIDER=tgpay`,
   `NEXT_PUBLIC_WITHDRAWALS_ENABLED=true`.
3. `./node_modules/.bin/medusa exec src/scripts/check-tgpay.ts` from
   `backend/packages/api` — proves keys + base URL.
4. Top up from the storefront wallet → hosted checkout → sandbox simulator →
   back to `/wallet`; confirm the `globepay_deposit` row settles and the ledger
   credits once.
5. Withdraw to the dummy bank → `globepay_withdrawal` row gets their
   `transactionRefNum` → payout callback settles or refunds it.

## Verified 2026-09-05

Deposit leg end to end on the sandbox: create-payment → hosted checkout →
FPX simulator → callback → ledger credit (plan 130 has the trace). Their
wallet page records net MYR 49.00 for a RM 50 FPX pay-in (fee RM 1.00: 1.2 %
floored at RM 1). Payout leg: after TGPay set the payout wallet's currency to
MYR (see below), `scripts/tgpay-payout-probe.ts` got a RM 50 payout ACCEPTED
(fee RM 1, `amountIncludeFee` 51) and its `success` callback reached
`/hooks/tgpay/withdrawal` within a minute; the payout wallet dropped 300 → 249.
On the sandbox their `transactionRefNum` equals our `merchantRefNum`.

Playwright smokes: `scripts/qa-tgpay-deposit.mjs` (top-up sheet → checkout),
`scripts/qa-tgpay-statement.mjs` (/transactions + /wallet),
`scripts/qa-tgpay-admin-audit.mjs` (admin Settlement page),
`scripts/qa-tgpay-bank-account.mjs` (save a bank on /bank),
`scripts/qa-tgpay-withdraw.mjs` (customer withdrawal), and
`scripts/qa-open-pack-api.mjs` (open a pack / sell back via the store API to
clear the playthrough gate — set `PAYOUT_DESTINATION_COOLDOWN_HOURS=0`
locally for a same-day withdrawal). A full customer withdrawal ran end to
end on the sandbox 2026-09-05: accepted, callback settled it, ledger −50.

## Resolved with TGPay (kept for the pattern)

- **Payout wallet not visible to the API** (sandbox, 2026-09-05 morning):
  `/transaction/payout/withdraw` → `400 No payout credit wallet found`,
  `/tenant-payout-credits/balance` → 404, while the admin showed payout credit
  300.00. Root cause on their side (their admin API
  `GET /api/v2/tenant-payout-credits/my`): the payout credit row had
  `currencyId: null`, so a lookup by MYR found nothing. CS set the wallet
  currency to MYR the same afternoon and payouts worked. **Watch for the same
  on the production tenant** — its Currency still shows "—".

## Open questions for TGPay

- Production admin + API base URLs, and whether production payout is enabled
  (`501 Payout not available in production yet` otherwise). Per TGPay
  2026-09-05: the production API keys are read from the production back
  office; its login is sent by email after the account is provisioned.
- ~~Callback source IPs~~ — given by TGPay 2026-09-05 (production callbacks
  may come from): `1.32.102.191`, `1.32.102.19`, `1.32.102.35`, `1.32.102.1`,
  `60.48.120.36`, `219.95.78.237`, `219.94.46.237`, `18.142.49.112`,
  `188.114.96.0`, `188.114.97.0` (Cloudflare range), `47.131.132.118`,
  `54.251.58.7`. TGPay then asked for an allowlist on our side ("请做 IP 白名单
  校验"), so both TGPay hooks now enforce `TGPAY_CALLBACK_IPS` when it is set
  (403 otherwise), judged on the client address DigitalOcean's ingress sets in
  `do-connecting-ip` (on App Platform, `x-forwarded-for` / `req.ip` name the
  ingress server itself — DO docs) — never on a caller-written
  `X-Forwarded-For`, which they explicitly warned against. The first accepted
  production callback logs `[tgpay] callback from <ip> accepted`; check it
  after cutover to confirm the address really is theirs. Leave it unset on
  the sandbox (their sandbox calls from unlisted addresses). Open question for
  them: are `188.114.96.0` / `188.114.97.0` single hosts or Cloudflare's
  `188.114.96.0/20`? The value accepts CIDR either way. Our egress `188.166.181.61` /
  `188.166.181.204` is whitelisted on their production as of the same day.
- Whether the hosted checkout link is ever absolute. A relative link is
  resolved against the checkout host paired with the API host
  (`sandbox-api.` → `sandbox-checkout.`, `api.` → `checkout.`); any other
  layout needs `TGPAY_CHECKOUT_BASE`.
- Payout status vocabulary beyond `pending | success | reject`: the client
  treats the whole terminal-failure family (reject/fail/cancel/expire/void/
  declined) as a refund, anything else as still pending. Ask them for the
  full list before relying on it.
- Payouts carry no customer id: `/transaction/payout/withdraw` has no
  free-text field (deposits use `additionalData`). The `merchantRefNum` is
  our withdrawal row id, which names the customer on our side.
