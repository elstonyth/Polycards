# TGPay payment gateway — setup notes

Status: **sandbox integration built 2026-09-05 (plan 130)**, behind the
`PAYMENT_GATEWAY=tgpay` switch. Production stays on GlobePay365 until the
switch is flipped there.

Source: the sandbox admin's own docs — <https://sandbox.tgpay365.com/docs/api>
and `/docs/sandbox-api` (login required). Their doc template leaves the base
URLs blank; the values below were confirmed by probing.

## Environments

|               | Sandbox                                       | Production                     |
| ------------- | --------------------------------------------- | ------------------------------ |
| Admin         | <https://sandbox.tgpay365.com/>               | ask TGPay (not shared yet)     |
| API base      | `https://sandbox-api.tgpay365.com/api/v2`     | ask TGPay                      |
| Hosted checkout | `https://sandbox-checkout.tgpay365.com/checkout?order=…` (absolute link, verified) | ask TGPay |

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

| Call | Endpoint | Notes |
| --- | --- | --- |
| Create payment | `POST /transaction/create-payment` | returns only `data.checkoutLink`; the `order` query param is their txn id |
| Query payment / payout | `POST /transaction/query` | by `merchantRefNum`; unknown → `404 Transaction not found` |
| Create payout | `POST /transaction/payout/withdraw` | needs `email`, `userName`, `bankAccNumber`, `bankCode` (SWIFT) + matching `bankName` |
| Pay-in balance | `POST /tenant-credits/balance` | `{ epoch, currency }` |
| Payout balance | `POST /tenant-payout-credits/balance` | separate wallet |

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

## Which gateway is active

An admin setting, not an env var: Settlement page → **Payment gateway**
(`GET/POST /admin/payments/gateway`, audited). `PAYMENT_GATEWAY` is only the
boot/fallback value. Set `PAYMENT_CALLBACK_BASE` (the backend's public origin)
so the notify URLs derive from each gateway's hook paths; without it an
explicit `GLOBEPAY_*_URL` is honoured only when it already names that
gateway's hook, and the switch refuses a gateway with no callback URL. Every
deposit/withdrawal row records its gateway, and the sweeps use the row's.

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
`scripts/qa-tgpay-admin-audit.mjs` (admin Settlement page).

## Open questions for TGPay

- **Payout wallet not visible to the API** (sandbox): `/transaction/payout/withdraw`
  → `400 No payout credit wallet found`, `/tenant-payout-credits/balance` → 404,
  while the admin shows payout credit 300.00. Blocks the payout test.
  **Root cause is on their side** (read from their admin API
  `GET /api/v2/tenant-payout-credits/my`, 2026-09-05): the payout credit row
  (id 18, balance 300) has `currencyId: null`, so a lookup by MYR finds
  nothing. The tenant's original credit row (id 21) is currency-less too; a
  real MYR pay-in row (id 22) only appeared when the first payment settled.
  **Resolved 2026-09-05**: CS set the wallet currency to MYR; payout works.
- Production admin + API base URLs, and whether production payout is enabled
  (`501 Payout not available in production yet` otherwise).
- Callback source IPs, if they publish any (we rely on the key headers).
- Whether the hosted checkout link is ever absolute; if it moves off the admin
  host, set `TGPAY_CHECKOUT_BASE`.
