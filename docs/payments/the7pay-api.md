# The 7 Pay — API reference (backup gateway)

Captured 2026-10-09 from the merchant dashboard docs (`https://admin.the7pay.com/docs/*`,
reachable after login; the `/docs` pages themselves claim not to need admin login). This is
a condensed copy of what we need to integrate — re-check the live docs before go-live, the
vendor's changelog still lists RSA signing as "Unreleased".

Merchant account: `polycards.gg` (role: Manager) on the production dashboard. Credentials are
NOT stored here.

## Environments

|            | Dashboard                   | API base                                 |
| ---------- | --------------------------- | ---------------------------------------- |
| Production | https://admin.the7pay.com   | `https://api.the7pay.com/api/v1`         |
| Sandbox    | https://sandbox.the7pay.com | `https://sandbox-api.the7pay.com/api/v1` |

Keys are per-environment. Get them from **Platform → Settings → API keys**
(`/platform-settings/api-keys`, reveal needs 2FA).

## Auth (every protected request)

| Header                           | Required                        | Notes                           |
| -------------------------------- | ------------------------------- | ------------------------------- |
| `Content-Type: application/json` | yes                             |                                 |
| `x-public-key`                   | yes                             | `pk-…`                          |
| `x-secret-key`                   | yes                             | `sk-…`, server-side only        |
| `x-rsa-signature`                | once an RSA public key is saved | Base64 RSA-SHA256 (PKCS#1 v1.5) |

### RSA request signing (recommended — protects payouts if pk/sk leak)

1. Generate a key pair (`openssl genrsa -out private.pem 2048` then
   `openssl rsa -in private.pem -pubout -out public.pem`; SPKI `BEGIN PUBLIC KEY`, ≥2048 bits).
2. Paste the public PEM into **Client public key** on the API keys page and save (2FA).
3. From then on every protected call must carry `x-rsa-signature`.

String to sign (UTF-8, single `\n` separators, no trailing newline):

```
METHOD
PATH
RAW_BODY
```

- `METHOD` uppercase.
- `PATH` includes the API prefix, no query string — e.g. `/api/v1/transaction/create-payment`.
- `RAW_BODY` = the exact bytes sent on the wire (sign the same string you POST). Empty for a bodyless GET.

```js
const toSign = `${method}\n${path}\n${rawBody}`;
const signature = crypto
  .sign('RSA-SHA256', Buffer.from(toSign, 'utf8'), privateKeyPem)
  .toString('base64');
```

### Replay window

Every request body carries `epoch` (Unix seconds). Rejected if outside ±5 minutes:
`400 Request epoch is expired. Must be within 5 minutes.`

## Conventions

- All amounts are **major units** (10 = RM 10.00), up to 2 decimals — in requests, responses and callbacks.
- Success: HTTP 200, body `{ "status": 1, "msg": "Success", "data": … }`.
- Errors: 4xx/5xx with NestJS-style body `{ statusCode, message, error }`, or validation
  `{ message: "Validation failed", errors: "a; b" }` (HTTP 400, no `statusCode`).

---

## Pay-in

### Create payment — `POST /transaction/create-payment`

```json
{
  "epoch": 1773376226,
  "customer": {
    "name": "john",
    "email": "johndoe@example.my",
    "phoneNumber": "0123456789"
  },
  "order": {
    "merchantRefNum": "123",
    "amount": 10,
    "redirectUrl": "https://your-domain.com/payment/complete",
    "notifyUrl": "https://your-domain.com/api/payment/notify",
    "additionalData": "optional text shown at checkout",
    "paymentMethod": "FPX | EWALLET | DUITNOW-QR",
    "channelId": "TNG_MY"
  }
}
```

| order field      | Required             | Notes                                                        |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| `amount`         | yes                  | major units                                                  |
| `merchantRefNum` | yes                  | our unique ref                                               |
| `redirectUrl`    | yes                  | browser return after success                                 |
| `notifyUrl`      | yes                  | server callback; **no callback is sent if empty**            |
| `additionalData` | no                   |                                                              |
| `paymentMethod`  | when `channelId` set | `FPX`, `EWALLET` (`E-WALLET` accepted), `DUITNOW-QR` (exact) |
| `channelId`      | no                   | custom checkout — see channel table                          |

Response:

```json
{
  "status": 1,
  "msg": "Success",
  "data": {
    "checkoutLink": "https://checkout.the7pay.com/checkout?order=757b…&datetime=…&amount=2.00"
  }
}
```

- **Hosted checkout** (no `channelId`): `checkoutLink` is the 7Pay page. Hosted offers FPX and
  E-wallet only; setting `paymentMethod` restricts the page to that rail (`pm=` query param).
- **Custom checkout** (`channelId` set): `checkoutLink` is a GET on the API,
  `/transaction/create-payment/{paymentMethod}/{channelId}/{order}`, which 302s into the bank/wallet.
  **Valid 5 minutes.** Account must be enabled for channel links.
- Server-side alternative to that GET: `POST /transaction/checkout/relay`
  `{ "order": "<7pay txn id>", "paymentMethod": "FPX", "channel": "<channelId>" }` →
  `{ "status": 1, "data": "<url>" }`.
- DuitNow QR is **custom checkout only**: `paymentMethod: "DUITNOW-QR"`, `channelId: "DUITNOW_QR_MY"`.

Duplicate `merchantRefNum`: at most one **pending** row per (tenant, ref). Re-using a pending ref
returns the same link (same amount) or 409 (different amount / race). Reusable after success/reject.

### Pay-in channel codes (production)

> "For integration in this platform, currently only E-wallet channels are enabled by default."
> Confirm with 7Pay which rails are live on our tenant.

| Rail       | channelId       | Name                               |
| ---------- | --------------- | ---------------------------------- |
| E-WALLET   | `TNG_MY`        | TNG eWallet                        |
| E-WALLET   | `GRABPAY_MY`    | GrabPay                            |
| E-WALLET   | `SHOPEEPAY_MY`  | ShopeePay (Payment Bank page only) |
| E-WALLET   | `WECHATPAY_CN`  | WeChatPay (Payment Bank page only) |
| E-WALLET   | `ALIPAY_CN`     | AliPay (Payment Bank page only)    |
| E-WALLET   | `BOOST_MY`      | Boost                              |
| DuitNow QR | `DUITNOW_QR_MY` | DuitNow QR                         |
| FPX        | `ABB_MY`        | Affin Bank                         |
| FPX        | `ABMB_MY`       | Alliance Bank                      |
| FPX        | `AMBB_MY`       | AmBank                             |
| FPX        | `ARGO_MY`       | ARBK                               |
| FPX        | `BIMB_MY`       | Bank Islam                         |
| FPX        | `BOCM_MY`       | Bank of China                      |
| FPX        | `BKRM_MY`       | Bank Rakyat                        |
| FPX        | `BSN_MY`        | BSN                                |
| FPX        | `CIMB_MY`       | CIMB                               |
| FPX        | `HLBB_MY`       | HL Bank                            |
| FPX        | `HSBC_MY`       | HSBC                               |
| FPX        | `KFH_MY`        | KFH Bank                           |
| FPX        | `MB2U_MY`       | Maybank                            |
| FPX        | `MBB_MY`        | Maybank2E                          |
| FPX        | `BMMB_MY`       | Muamalat                           |
| FPX        | `MBSB_MY`       | MBSB Bank                          |
| FPX        | `OCBC_MY`       | OCBC                               |
| FPX        | `PBB_MY`        | Public Bank                        |
| FPX        | `RHB_MY`        | RHB                                |
| FPX        | `SCB_MY`        | SC                                 |
| FPX        | `UOB_MY`        | UOB                                |

Sandbox-only channel ids: `SANDBOX_BANK_FPX_MY` (FPX), `SANDBOX_TNG_EWALLET_MY` (EWALLET),
`SANDBOX_DUITNOW_DUITNOWQR_MY` (DUITNOW-QR). Each opens a simulator then redirects to `redirectUrl`.

### Query payment — `POST /transaction/query`

```json
{ "epoch": 1773376226, "merchantRefNum": "123", "txnRefNum": "d34e…" }
```

At least one of `merchantRefNum` / `txnRefNum`. Returns the **latest** matching row (createdAt desc).

```json
{
  "status": 1,
  "msg": "Success",
  "data": {
    "order": "cf00…",
    "amount": 100.0,
    "fee": 1.5,
    "amountAfterFee": 98.5,
    "status": "APPROVED",
    "datetime": "03-03-2026 11:05:10",
    "redirectUrl": "…",
    "paymentMethod": "FPX",
    "bankName": "Maybank"
  }
}
```

`status` examples: `APPROVED`, `PENDING` (full enum not documented — confirm the reject value).
`fee` is 0 until settled. `datetime` format `DD-MM-YYYY HH:mm:ss` (timezone not stated).

### Payment callback (to our `notifyUrl`)

POST JSON, wrapped like API responses. **At-least-once — handler must be idempotent.** Return 2xx.

```json
{
  "status": 1,
  "msg": "Success",
  "data": {
    "amount": 2.0,
    "transactionRefNum": "123",
    "merchantRefNum": "456",
    "paymentMethod": "FPX",
    "bankName": "Maybank",
    "status": "APPROVED"
  }
}
```

Sent "after a payment succeeds" — docs do not say whether failures are notified.

---

## Payout

### Create payout — `POST /transaction/payout/withdraw`

```json
{
  "epoch": 1773376226,
  "merchantRefNum": "123",
  "email": "johndoe@example.my",
  "userName": "johndoe123",
  "amount": 10,
  "bankAccNumber": "00601010602",
  "bankCode": "HLBBMYKL",
  "bankName": "Hong Leong Bank Berhad",
  "notifyUrl": "https://your-domain.com/api/payout/notify"
}
```

All fields required. `bankCode` + `bankName` must be a pair from the table below (provider routes
on `bankCode`). `amount` is net to the recipient; our fee is added on top from the payout wallet.

```json
{
  "status": 1,
  "msg": "Success",
  "data": {
    "transactionRefNum": "d34e…",
    "order": { "merchantRefNum": "123", "amount": "10.00" },
    "recipient": {
      "name": "johndoe123",
      "email": "…",
      "bankAcc": "00601010602",
      "bankName": "Hong Leong Bank Berhad",
      "bankCode": "HLBBMYKL"
    }
  }
}
```

Note `order.amount` comes back as a **string** here. `501 Payout not available in production yet`
means payout isn't enabled on our tenant.

### Payout bank codes (production)

| Bank name                                                   | bankCode    |
| ----------------------------------------------------------- | ----------- |
| Affin Bank Berhad                                           | `PHBMMYKL`  |
| AGROBANK / BANK PERTANIAN MALAYSIA BERHAD                   | `AGOBMYKL`  |
| Alliance Bank Malaysia Berhad                               | `MFBBMYKL`  |
| AL RAJHI BANKING & INVESTMENT CORPORATION (MALAYSIA) BERHAD | `RJHIMYKL`  |
| AmBank (M) Berhad                                           | `ARBKMYKL`  |
| Bank Islam Malaysia Berhad                                  | `BIMBMYKL`  |
| Bank Kerjasama Rakyat Malaysia Berhad                       | `BKRMMYKL`  |
| Bank Muamalat (Malaysia) Berhad                             | `BMMBMYKL`  |
| Bank Simpanan Nasional Berhad                               | `BSNAMYK1`  |
| CIMB Bank Berhad                                            | `CIBBMYKL`  |
| Citibank Berhad                                             | `CITIMYKL`  |
| GX BANK                                                     | `GXBKMYKL`  |
| Hong Leong Bank Berhad                                      | `HLBBMYKL`  |
| HSBC Bank Malaysia Berhad                                   | `HBMBMYKL`  |
| Kuwait Finance House                                        | `KFHOMYKL`  |
| Maybank / Malayan Banking Berhad                            | `MBBEMYKL`  |
| OCBC Bank (Malaysia) Berhad                                 | `OCBCMYKL`  |
| Public Bank Berhad                                          | `PBBEMYKL`  |
| RHB Bank Berhad                                             | `RHBBMYKL`  |
| RYT BANK                                                    | `RYTBKMYKL` |
| Standard Chartered Bank (Malaysia) Berhad                   | `SCBLMYKX`  |
| Touch 'n Go                                                 | `TNGDRMYKL` |
| United Overseas Bank (Malaysia) Berhad                      | `UOVBMYKL`  |

Sandbox: use only `DUMMYBANKVERIFIED` / `Dummy Bank Verified` (example acc `543478924652`, name `Michael Yap`).

### Query payout — `POST /transaction/query`

Same endpoint as pay-in; send `merchantRefNum` and/or `transactionRefNum` (the payout ref).

```json
{
  "status": 1,
  "msg": "Success",
  "data": {
    "status": "APPROVED",
    "order": {
      "payoutRefNum": "d34e…",
      "merchantRefNum": "123",
      "amount": 100,
      "fee": 1,
      "amountIncludeFee": 101
    },
    "recipient": {
      "name": "…",
      "email": "…",
      "bankAcc": "1",
      "bankName": "Affin Bank"
    }
  }
}
```

### Payout callback (to our `notifyUrl`)

POST JSON, **flat** (not wrapped). At-least-once; key idempotency on `transactionId`.

```json
{
  "transactionId": "26041119280373448333",
  "status": "success",
  "amount": 100,
  "fee": 1,
  "paymentAt": "2026-04-11T12:31:07.000Z",
  "orderno": "26041119280373448333",
  "payType": "PAYOUT"
}
```

`status`: `pending` | `success` | `reject` (lowercase — differs from query's `APPROVED`).
No `merchantRefNum` in the body — map from the `transactionRefNum` we stored at create time.

---

## Callback verification (both callbacks)

Chosen per tenant on the API keys page:

- **Method 1 (default):** incoming request carries `x-public-key` + `x-secret-key`; compare to ours.
  (Weak: the secret travels on every callback.)
- **Method 2:** only `x-signature` = hex HMAC-SHA256 of the **raw body**, key = `publicKey + secretKey`.
  Verify against raw bytes with a timing-safe compare. **Prefer this.**

```js
const expected = crypto
  .createHmac('sha256', `${publicKey}${secretKey}`)
  .update(rawBody, 'utf8')
  .digest('hex');
```

## Balances

- `POST /tenant-credits/balance` `{ epoch, currency: "MYR" }` → pay-in wallet `{ balance, currency }`.
- `POST /tenant-payout-credits/balance` → payout wallet. 404 if no wallet for that currency.

## Error messages worth matching

| HTTP | message                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 400  | `Request epoch is expired. Must be within 5 minutes.`                     |
| 401  | `x-public-key and x-secret-key headers are required` / `Invalid API keys` |
| 401  | `RSA signature is required` / `Invalid RSA signature`                     |
| 404  | `Transaction not found`                                                   |
| 409  | duplicate pending `merchantRefNum` with a different amount                |
| 501  | `Payout not available in production yet (contact The 7 Pay)`              |

## Production tenant `Polycards.gg` (read 2026-10-09, Platform → Settings → General)

- Currency MYR (set — unlike TGPay's production tenant at cutover).
- Pay-in MDR, "Native" tab: FPX 1.2 % (min charge RM 1), E-wallet 1.5 % (min 0), DuitNow QR 1.6 % (min 0).
  "Third party" tab: all "Not set". Per-transaction min/max are blank everywhere ("leave empty to use
  the default transaction amount limits" — defaults not shown; ask 7Pay).
- Payout: 0.6 % (floor RM 1), **RM 100 – 30,000 per request** (TGPay's floor is RM 50).
- Settlement withdrawal: fixed RM 10 fee, minimum RM 0. Owner name / ID / bank fields empty — fill
  them so pay-in balance can be settled out.

## Relationship to TGPay

Same platform, white-labelled: identical paths, headers, `epoch` window, response wrapper, error
strings, callback shapes, SWIFT table, sandbox dummy bank and `api.` ↔ `checkout.` host pairing as
`docs/payments/tgpay-setup.md`. Differences found so far: base path `/api/v1` (TGPay `/api/v2`),
optional RSA request signing, and the Method 2 HMAC callback. Implication: one client, two configs —
but also that a platform-level outage could take both gateways down at once.

## Integration in this repo

The 7 Pay is the gateway id `the7pay`, a second entry in the gateway registry
(`modules/packs/gateway.ts`) that reuses TGPay's client and adapter:

- `modules/packs/tgpay-client.ts` — one client for the platform. `kind`
  (`tgpay` | `the7pay`) picks the env prefix and the label in errors. RSA
  signing turns on when `<PREFIX>_RSA_PRIVATE_KEY` is set. Callbacks pass on
  either the key headers (Method 1) or the raw-body HMAC (Method 2). Error
  codes (`TGPAY_NOT_FOUND`, `TGPAY_PAYOUT_FLOAT_EMPTY`, …) are shared, so the
  refund and ops-alert branches fire the same way for both gateways.
- `api/utils/tgpay-family-hooks.ts` — both callback handlers, bound per gateway
  by `api/hooks/the7pay/{deposit,withdrawal}/route.ts`. A 7Pay-authenticated
  callback can only ever touch a `the7pay` row.
- `api/middlewares.ts` — `/hooks/the7pay/*` gets the shared hook rate limiter,
  its own `THE7PAY_CALLBACK_IPS` allowlist, and `preserveRawBody` for the HMAC.
- `modules/packs/banks.ts` — The 7 Pay pays to the same SWIFT pairs as TGPay.
  That includes Touch 'n Go eWallet (`TNGDRMYKL`, live for TGPay since #713).
  Both tables also list GX Bank (`GXBKMYKL`) and Ryt Bank (`RYTBKMYKL`), which
  are not mapped yet; saved accounts at those stay "not available with the
  current payout provider".
- The payout-wallet-empty breaker is per gateway, so TGPay's empty wallet does
  not block withdrawals after a switch to The 7 Pay.

Env (backend; names in `.env.template`): `THE7PAY_API_BASE`,
`THE7PAY_PUBLIC_KEY`, `THE7PAY_SECRET_KEY`, optional `THE7PAY_CURRENCY`,
`THE7PAY_CHECKOUT_BASE`, `THE7PAY_RSA_PRIVATE_KEY`, and `THE7PAY_CALLBACK_IPS`
(required outside the sandbox — without it the hooks refuse every callback).
`PAYMENT_CALLBACK_BASE` is shared; the notify URLs become
`<base>/hooks/the7pay/deposit` and `<base>/hooks/the7pay/withdrawal`.

### Go-live checklist

1. Sandbox: get a sandbox tenant from 7Pay, put its keys in the local backend
   env, prove them with
   `./node_modules/.bin/medusa exec src/scripts/check-tgpay.ts the7pay`, then run
   one deposit and one payout (dummy bank) end to end through a tunnel.
   `medusa exec src/scripts/tgpay-payout-probe.ts the7pay` sends one payout
   at the floor to the dummy bank outside our ledger.
2. Production keys: Platform → Settings → API keys (reveal needs 2FA). Choose
   callback **Method 2**. Generate an RSA pair, keep the private key in the
   deploy secrets as `THE7PAY_RSA_PRIVATE_KEY`, and paste the public PEM into
   "Client public key". Save the public key only once the deploy carrying the
   private key is live — after the save, unsigned calls are refused.
3. Ask 7Pay for their callback IPs (`THE7PAY_CALLBACK_IPS`) and give them our DO
   egress IPs (`188.166.181.61`, `188.166.181.204`) in case the API is
   IP-allowlisted per tenant like TGPay's.
4. Deploy wiring, in ONE change and only once the production keys exist:
   put `THE7PAY_PUBLIC_KEY`, `THE7PAY_SECRET_KEY` and `THE7PAY_RSA_PRIVATE_KEY`
   (PEM on one line, `\n` between lines) in `deploy/.env.deploy`; add
   `__SECRET__THE7PAY_…__` placeholders (type SECRET) plus `THE7PAY_API_BASE`
   and `THE7PAY_CALLBACK_IPS` to `.do/backend.app.yaml`; and add the three
   secret names to `$secretKeys.backend` in `scripts/do-apply.ps1`. That list
   is mandatory on every apply, so adding a name before its value exists blocks
   every backend deploy. Edit the spec by script and check the diff — a
   formatting editor re-quotes the existing TGPay secret placeholders. Apply
   with `pwsh scripts/do-apply.ps1 backend -Validate` first, then for real, and
   run the preflight from inside DO.
5. Fund The 7 Pay's payout wallet before switching withdrawals to it — the
   preflight prints both wallet balances. TGPay's production payout wallet was
   0.00 at its cutover, and every payout fails until it is topped up.
6. Switching: Settlement page → Payment gateway → The 7 Pay. The switch refuses
   a gateway whose config is incomplete (missing base URL / public key /
   unreadable RSA key). Rows already in flight finish on the gateway they
   started on.

## Open questions for 7Pay

1. Which pay-in rails are enabled on the `polycards.gg` tenant (docs say e-wallet only by default)?
2. Full pay-in `status` enum — what does a failed/expired payment report? Is a callback sent on failure?
3. Callback retry schedule, and callback source IPs (for an allowlist like TGPay's).
4. Is payout enabled in production for us, and what are the pay-in/payout fees?
5. Timezone of `datetime` in query responses.
6. Settlement: when does pay-in balance move to the payout wallet?
