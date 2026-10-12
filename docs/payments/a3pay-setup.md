# A3Pay (Singapore, SGD) setup

A3Pay is a **regional rail**. It runs beside the active RM gateway (TGPay) and never replaces it:

- **Top-ups.** Singapore customers choose **Pay in S$** on the top-up sheet. They pay in SGD by PayNow QR (`BQR`) or bank transfer (`OB`), and are credited **RM** at today's rate minus our markup.
- **Withdrawals.** A saved Singapore bank account (DBS, POSB, OCBC, UOB, PayNow…) is paid out through A3Pay in SGD. The rate is today's rate plus our markup. Malaysian accounts still go through the active gateway.
- **Ledger and fences stay in RM.** The ledger, playthrough, limits and every money fence work in RM. Each SGD row **locks** its quote (`currency`, `gateway_amount`, `fx_mid`, `fx_markup`). Callbacks, the sweep, the audit job and admin approvals all convert through that lock, never through today's rate.
- **The admin switch never offers A3Pay.** `setActiveGateway` refuses it. This prevents RM top-ups from being routed to an SGD rail.

Handbook: <https://api.a3paysg.com/API/a3pay_api_doc.html> (v3.3.5, SGD only). Code:

- `modules/packs/a3pay.ts`: the wire format.
- `a3pay-client.ts`: the HTTP client.
- `payment-fx.ts`: quotes and conversion.
- `gateway.ts`: the adapter and registry entry.
- `api/hooks/a3pay/*`: the callback handlers.

## The conversion and the markup

- `mid` is the SGD→MYR market rate. The `sync-payment-fx` job fetches it from frankfurter (ECB) every 6 h. An admin can pin a manual rate instead.
- **`markup` is absolute, in RM per S$1, and is taken both ways.** With mid 3.20 and markup 0.05:
  - A top-up credits 3.15 per S$1, so S$100 becomes RM 315.00.
  - A payout pays 3.25 per S$1, so RM 100 becomes S$30.76.
- Rounding is always down to the cent, in our favour.
- Set the rate and markup in **Admin → Settlement → "SGD conversion"** (one card per regional currency; `GET/POST /admin/payments/fx?currency=SGD`):
  - Every save needs a reason and is audited (`admin_action_audit`, entity `fx`, id `SGD_MYR`).
  - The card previews the customer rates live and shows **Conversion earned**: Σ(S$ × mid − RM credited) over settled top-ups, plus Σ(RM debited − S$ × mid) over settled payouts.
- **No fallback rate.** SGD top-ups and payouts are refused ("SGD payments are paused") in two cases:
  - No `SGD_MYR` row exists.
  - The feed is older than 7 days (ECB skips holidays) and no manual rate is set.
- **The customer sees the rate they get.** The top-up sheet and the withdraw form send the rate they showed (`quoted_rate`). If an admin moved the markup in between, the backend refuses before any row or debit ("The exchange rate just changed"), and the form re-reads the rate.
- **Adding a regional currency (USDT next):** one `GATEWAYS` entry (backend `gateway.ts`), one `PAYMENT_FX_FEEDS` entry (`payment-fx.ts`; no `url` means manual rate only), one `REGIONAL_RAILS` entry (storefront `src/lib/regional-rails.ts`), and one `REGIONAL_CURRENCIES` entry on the admin Settlement page. Payout destinations for a wallet (not a bank) are not built yet.
- A rate change never affects payments already started. Held payouts are approved at the S$ amount locked when the customer asked.

## Onboarding with A3Pay (the Telegram checklist)

1. **Merchant RSA key.** Generate it locally. **Never use the online generator**: a private key made on someone else's web page is not private.

   ```bash
   node scripts/a3pay-keygen.mjs --bits 2048
   ```

   - The private key (PKCS#8) is written to `backend/packages/api/.env` as `A3PAY_MERCHANT_PRIVATE_KEY` and is never printed.
   - The public key (X.509 SPKI, base64) is printed and saved to `docs/payments/a3pay-merchant-public-key.txt`. **Send that to A3Pay.**
   - Generated 2026-10-06 as RSA-2048. A3Pay's message asked for 1024. If their back office refuses 2048, rerun with `--bits 1024 --force`, but only before they register the key.
   - **Back the private key up** to the production secret store. It currently exists only in the local `.env`.

2. **IP whitelist.** Send the backend's dedicated egress IPs: **`188.166.181.61`** and **`188.166.181.204`** (service + worker; confirmed with `doctl apps get … dedicated_ips` on 2026-10-06). Both are needed because the reconcile sweeps run on the worker.

3. **Ask A3Pay for:**
   - The MID / MerchantCode.
   - The **AES key**.
   - **A3Pay's public key**.
   - A UAT/sandbox environment, if one exists.
   - Per-transaction limits for payin and payout.
   - The error codes for "transaction not found" and "insufficient merchant balance". Until we have them, an ambiguous SGD payout is never auto-refunded. This is the safe direction, but it needs a human.

## Production env (backend service + worker)

| Var                          | Value                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| `A3PAY_ENABLED`              | `true` to open the rail (credentials can ship first with `false`) |
| `A3PAY_API_BASE`             | `https://mapi.a3paysg.com`                                        |
| `A3PAY_MERCHANT_CODE`        | MID from A3Pay, e.g. `SGD00001`                                   |
| `A3PAY_AES_KEY`              | secret, from A3Pay                                                |
| `A3PAY_MERCHANT_PRIVATE_KEY` | secret, ours (PKCS#8 base64)                                      |
| `A3PAY_PUBLIC_KEY`           | A3Pay's public key (X.509 base64)                                 |
| `A3PAY_CALLBACK_IPS`         | optional; defaults to A3Pay's documented `13.192.222.226`         |
| `A3PAY_CURRENCY`             | optional; defaults to `SGD`                                       |

Callbacks go to `PAYMENT_CALLBACK_BASE` plus the following paths. Payout verification answers `success` only for our pending row at the locked S$ amount.

- `/hooks/a3pay/deposit`
- `/hooks/a3pay/withdrawal`
- `/hooks/a3pay/payout-verify`

**Deploy order:** run `Migration20261012120000` (it adds `fx_rate.markup` and the FX lock columns) **before** the new code serves traffic. The new inserts name those columns.

**After deploy**, from `packages/api` on the production worker:

```bash
./node_modules/.bin/medusa exec src/scripts/check-a3pay.ts
```

This refreshes the SGD rate. Its `CheckAccBalance` call is a single signed call that proves the key, AES key, MID and IP whitelist together. It also lists A3Pay's live payout bank codes, which you compare against `SG_BANKS` in `banks.ts`.

## Confirmed live (2026-10-12)

Read from the A3Pay back office (https://backoffice.a3paysg.com, login `polycards`, IP-whitelisted) and probed against the production API from the whitelisted office IP `60.48.37.10`. No money moved.

- **Merchant code (MID):** `polycards`, currency SGD.
- **Keys:** our public key is registered exactly as generated. The AES key matches. A3Pay's public key is RSA-1024.
- **Back-office flags:** IP Whitelist Check **Active**, Payout Verification **Inactive**, Fund In Verification timeout 10 min. Ask A3Pay to switch Payout Verification on once `/hooks/a3pay/payout-verify` is deployed. It is a free second check on every payout.
- **Limits and fees (Merchant Transaction Setting):**
  - Deposit OB and BQR: S$10–5,000, **2.5% fee**.
  - Payout WD: S$50–10,000, **1.5% fee**.
  - Settlement: S$1,000–10,000, S$10 flat fee.
  - `currencyLimits` uses these. The top-up band is also narrowed so the RM credit fits the RM 10,000 ceiling.
- **The markup must cover the fees.** At mid ≈ 3.19:
  - A 2.5% deposit fee is ≈ RM 0.080 per S$1.
  - A 1.5% payout fee is ≈ RM 0.048 per S$1.
  - A markup below ≈ 0.08 loses money on every top-up. 0.10 or more is the sensible floor.
- **Payout banks (GetSupportedBankList):** 21 codes. `SGANEXT` (ANEXT Bank) is live but missing from the handbook, so it was added. Wise, LiquidPay and Dash are listed but not offered (their payees are not digit account numbers).
- **Requery not-found:** `GetPayinDetail` and `GetPayoutDetail` answer **HTTP 400 `{"isSuccess":false,"errorCode":null,"errorMessage":"Not found"}`**, not the GlobePay-era `PMT10016`. The client tags this as `A3PAY_NOT_FOUND`. The failure modes it must not be confused with look different:
  - A wrong AES key gives HTTP 400 plain-text `Invalid Request`.
  - A wrong MerchantCode gives HTTP 403.
- **A3Pay does not verify our RSA signature on read calls.** A request signed with the wrong key gets the same answer. So the AES key plus the IP whitelist are what protect reads. Ask A3Pay to confirm that `SubmitPayout` does verify signatures.
- **Response field casing:** the balance response sends `mid` (the handbook shows `mID`) plus `t1BalanceAmount`. Both are handled.

## Still to confirm with A3Pay

- Whether `SubmitPayout` / `CreatePayin` verify our signature (reads do not).
- Whether callbacks and requery report the requested amount or the uniqueness-nudged one.
- **Payer name:** SGD payins require `FromCustomerAccountHolderName`. The sheet asks for "Name on your bank account". Ask how strictly it is matched.
- **Bank ids:** canonical ids are SWIFT-style (`DBSSSGSG`, `POSBSG`…). Bare A3Pay codes (`CIMB`, `UOB`…) are deliberately **not** lookup aliases, so a Malaysian account can never be re-homed to Singapore.

## Local testing (no sandbox exists)

```bash
node scripts/a3pay-mock.mjs
```

The mock serves the real wire format:

- It **refuses** a request whose signature does not verify.
- It signs its callbacks with its own key, as production does.
- It writes the backend env to `%TEMP%/a3pay-mock.env`.

Start the backend with that env layered over `.env`, plus:

- `GATEWAY_ENABLED=true`
- `GATEWAY_WITHDRAWALS_ENABLED=true`
- `PAYMENT_CALLBACK_BASE=https://polycards-local.test`
- `PAYOUT_DESTINATION_COOLDOWN_HOURS=0`

Then run the end-to-end checks:

```bash
node scripts/a3pay-e2e.mjs
```

```bash
node scripts/a3pay-e2e.mjs payouts
```

```bash
node scripts/qa-a3pay-ui.mjs
```

- `a3pay-e2e.mjs` checks over HTTP and against the DB rows:
  - rate lock
  - callback and sweep settlement
  - payin status 4 / 7
  - signature and band guards
  - payout verify, settle and refund
  - held approval at the locked rate
  - the earnings figure
- `payouts` runs only the payout legs, for a customer whose deposits are already played through.
- `qa-a3pay-ui.mjs` uses Playwright against the standalone :4000 build and the :7000 admin. Screenshots go to `docs/research/a3pay-*.png`.

**Trying it by hand:**

1. On the top-up sheet, choose **Pay in S$** and pay.
2. The browser lands on `https://cashier.a3pay.mock/cashier/D…`. This host does not exist, so the page shows a DNS error. That is expected.
3. Copy the `D…` order id from the address bar.
4. Open `http://localhost:4455/cashier/<orderId>` and click **Pay now**. The mock sends the signed callback and sends you back to `/me` with the RM credit.

Phone OTP is currently limited to Malaysian visitors (`OTP_VISITOR_COUNTRIES = ['MY']`, operator decision 2026-10-04). If phone verification gates sign-up or withdrawals, Singapore customers will hit it.
