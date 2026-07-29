# GlobePay365 payment gateway — setup notes

Status: **Phase 1 (onboarding) in progress.** No code written yet — MerchantCode
is not issued until GlobePay365 finishes back-office setup.

Source: <https://api.globepay365.com/api/globepay365_api_doc.html> (Merchant
Integration Guide v1.0.0).

## Environments

|                                            | Production                     | Staging                                  |
| ------------------------------------------ | ------------------------------ | ---------------------------------------- |
| API host                                   | `https://mapi.GlobePay365.com` | `https://mapi.GlobePay365stg.com`        |
| Back office                                | —                              | <https://backoffice.globepay365stg.com/> |
| Their outbound IP (our callback allowlist) | `13.159.14.239`                | `160.250.92.219`                         |

## Crypto scheme (verified against Node in a scratch script)

- **AES** (payload `Data` field): key = `PBKDF2-HMAC-SHA1(password=aesKey,
salt=aesKey, 1000 iters, 32 bytes)`, `AES-256-CBC` + PKCS7, random 16-byte IV
  **prepended** to the ciphertext, whole thing base64.
- **Signature**: `RSA-SHA1` (PKCS#1 v1.5) over the **plaintext JSON** of the
  `Data` object — sign outbound with the _merchant private key_, verify inbound
  callbacks with the _GlobePay365 public key_.
- Keys are 1024-bit. Legacy/weak by modern standards; it is their protocol, do
  not "upgrade" to 2048 or SHA-256.

## Secrets (env, never committed)

| Var                             | What                                         |
| ------------------------------- | -------------------------------------------- |
| `GLOBEPAY_MERCHANT_CODE`        | `Testpolycard` on staging                    |
| `GLOBEPAY_MERCHANT_PRIVATE_KEY` | our RSA 1024 private key (PEM)               |
| `GLOBEPAY_PUBLIC_KEY`           | their RSA public key (base64 SPKI)           |
| `GLOBEPAY_AES_KEY`              | their AES key                                |
| `GLOBEPAY_API_BASE`             | **required, no default** — staging `https://mapi.GlobePay365stg.com`, production `https://mapi.GlobePay365.com` |
| `GLOBEPAY_ENABLED`              | `true` to arm the real gateway (fails closed) |
| `GLOBEPAY_NOTIFY_URL`           | public callback URL — their POST target |
| `GLOBEPAY_RETURN_URL`           | where the customer lands after paying |

Storefront (public, not a secret): `NEXT_PUBLIC_PAYMENTS_PROVIDER=globepay`
switches the top-up sheet from the mock gateway to the redirect flow; anything
else keeps the mock. `GLOBEPAY_NOTIFY_URL` and `GLOBEPAY_RETURN_URL` are
explicit rather than derived — production names its storefront var
`MERCUR_STOREFRONT_URL`, so deriving would silently fall back to a localhost
default and the gateway would call an address that does not exist.

Merchant keypair was generated **locally with openssl**, not on devglan.com or
any other web tool — that private key signs withdrawal/payout requests, so a key
that ever touched a third-party site is a drain-the-balance risk.

```sh
openssl genrsa -out merchant_private.pem 1024
openssl rsa -in merchant_private.pem -pubout -out merchant_public.pem
# base64 body to hand over:
grep -v '^-----' merchant_public.pem | tr -d '\n'
```

## Account facts (read from the staging back office, 2026-07-21)

- **MerchantCode: `Testpolycard`** (capital T — same string as the BO login).
- Currency `MYR`. Cashier timeout 10 min. Payout Verification inactive.
- `IP Whitelist Check: Active` — so the API whitelist is enforced, not advisory.
- Merchant Public Key in their back office is byte-identical to ours. Confirmed.
- Active MYR methods: `FPX`, `DN` (DuitNow), `BQR` (QR & bank transfer), `OB`
  (Online Banking), `WD` (payout).
- **Two separate whitelists**, both need our IP:
  `Setting → Whitelist Setting → BackOffice Whitelist Setting` (login) and
  `→ API Whitelist Setting` (API calls). Getting only the first one done is the
  default failure — logins work, every API call is rejected.
- **Merchant Cashier URL is blank** (`Merchant Management → Action → URL`).
  Doc error `PMT10007 Merchant Cashier URL not available` is this field. Unset
  as of writing; ask Bryan what it expects before filling it.

### Live SubmitDeposit findings — 2026-07-21

First real deposit created: `D2026072112415767` (`BQR`, MYR 50.00, unpaid).

**Only `BQR` actually works on staging right now.** The back office lists five
active MYR methods; four of them fail at the channel level:

| Method | MYR 50 result                                                   |
| ------ | --------------------------------------------------------------- |
| `BQR`  | works — returns cashier URL + bank details + QR                 |
| `FPX`  | `PMT10018 Channel is not available`                             |
| `OB`   | `PMT10005 Invalid Transaction Amount`                           |
| `DN`   | `isSuccess:false` with an EMPTY errorList — no code, no message |
| `WD`   | payout, not tested                                              |

"Active in the back office" ≠ "a channel is provisioned". Ask Bryan to enable
the methods we actually intend to ship.

**Minimum amount.** `FPX` rejects 10 / 20 / 25 with `PMT10005`, then flips to
`PMT10018` at 30+ — so the floor is between 25 and 30, and `PMT10005` is
overloaded (it also fires for `OB` at 50). Do not infer limits from this error;
read `Merchant Transaction Setting` in the back office instead.

Other confirmed behaviour:

- `Amount` as the 2dp string `"50.00"` is accepted. Format confirmed.
- The **blank Cashier URL did NOT trip `PMT10007`** — that field is not
  required for this flow. Open question closed.
- An unpaid deposit requeries as `statusId 4 "VerifyFail"`, which is
  **pending**, not failed. Live confirmation that mapping 4 to failure would
  strand real money.
- Requery of an unknown id returns HTTP 400 with plain-text `Not found` — not
  JSON, and not the documented `PMT10016`.
- The response carries an undocumented `bankBranchCode`, and `qrCode` is a
  ~130 KB base64 PNG data URI. Never log or persist `qrCode` — pass it straight
  to the UI.
- `DN`'s empty-error response is why the client treats `isSuccess:false` with
  no codes as a generic failure rather than assuming a code exists.

### NO MYR method completes end-to-end on staging (2026-07-21)

> **Partly superseded (2026-07-22 afternoon).** BQR later rendered scannable
> DuitNow QRs on every attempt, and an OB cashier rendered a bank-list page.
> Still true: nobody has ever completed a payment through either. See
> "Operator visibility + callback probe" at the end of this file.

`BQR` was believed to work because `SubmitDeposit` returns a cashier URL. It
does not. Opening that URL in a browser gives:

1. a caution modal (`注意/Perhatian/Caution`, "This QR code only for one time
   used") with **Cancel / I Agreed**, then
2. after agreeing, **"Sorry, we're experiencing technical issues. Please try
   again later."** — on a deposit barely a minute old, so this is not expiry.

So the score is: four MYR methods fail at the API (`PMT10018` / `PMT10005` /
empty errorList) and the fifth fails at the cashier. **Nothing is payable on
staging right now.** A returned cashier URL is not evidence a channel works —
only a rendered QR is.

Also observed: two deposits created minutes earlier requeried as HTTP 400
`Not found` while an older one resolved normally. Either their requery lags
behind submit, or those deposits were never fully persisted. Unresolved — but
it is why the reconciliation sweep only expires an unknown deposit after an
hour instead of writing it off on the first `Not found`.

### BQR amount limits (probed live, `PMT10005` = out of range)

| Amount               | Result                               |
| -------------------- | ------------------------------------ |
| 1 / 5 / 10 / 20 / 25 | rejected                             |
| 30                   | accepted                             |
| 30.50                | accepted — 2 decimal places are fine |
| 1000                 | accepted                             |
| 5000 / 10000         | rejected                             |

So the usable band is roughly **26–1000 MYR**, exact bounds unconfirmed. Read
`Merchant Transaction Setting` for the real numbers rather than trusting this.

### GetSupportedBanks

`GET /api/Bank/GetSupportedBanks?MerchantCode=&PaymentMethodCode=WD&CurrencyCode=MYR`
— plain GET, **no AES and no signature**, unlike every other endpoint. Returns
31 live MYR banks. Their codes do not all match the doc's Bank Appendix
(`ACDB`, `AFBQ`, `BIGB`, `KAFD` are missing from it), so drive the payout bank
picker from this endpoint, never the appendix.

### Signed vs unsigned callback fields (read before touching the route)

Only `Data` is covered by the RSA signature. `TransactionId`,
`MerchantTransactionId` and `Version` sit in the envelope **outside** it and can
be altered on an otherwise-genuine body without invalidating anything.

Nothing security-relevant may be derived from them. The idempotency anchor uses
the **signed** `MerchantTransactionId`; the unsigned `TransactionId` is a
display-only reconciliation handle. A security review found the original code
anchoring on the unsigned field, which let one captured callback be replayed
with varied ids to mint unlimited credit — and would have double-credited with
no attacker at all if the gateway ever varied that id across its own retries.
Fixed in `99fc439f`, with unit + integration regressions.

### Reconciliation

`src/jobs/globepay-reconcile.ts`, every 10 minutes. Requeries `pending`
deposits (oldest first, 50 per sweep) because a dropped callback would
otherwise mean a customer paid and never got credit, permanently.

- Crediting uses the **same** anchor as the callback route, so a callback and a
  sweep racing on one deposit produce exactly one credit.
- Success settles at any age — the stale window never writes off money that
  landed. Only non-final deposits older than `GLOBEPAY_STALE_AFTER_MS` (1 h,
  vs their 10-minute cashier timeout) are expired.
- A requery 400 `Not found` means SubmitDeposit never took; those expire once
  old enough that an in-flight submit is impossible.
- One failing deposit never aborts the sweep.

### `Amount` vs `NetAmount` — ANSWERED 2026-07-22

Credit **`Amount`**. Confirmed by the provider: "请用 amount 上分 … net amount
是减了费用" — `NetAmount` is the figure after their fees are deducted, so
crediting it would silently short every customer by the fee. The route already
credits `Amount`; no change was needed.

### Provider answers, 2026-07-22

| Question | Answer |
| --- | --- |
| Amount limits | Min **RM 30**, max **RM 1000** (Bryan) |
| Which methods to use | "使用 OB 和 BQR 即可" (Sean) |
| Which field to credit | `Amount`, not `NetAmount` (Mizuko) |

Limits verified live: 1000 accepted, 1001 → `PMT10005`. They match the floor
found by probing on 2026-07-21, and are now enforced in both the storefront
sheet and `startGlobePayDeposit` so an impossible amount never reaches the
gateway.

**Still unanswered:** how to mark a staging deposit as paid so a callback fires.
Asked twice. Without it no genuine callback can ever reach us.

**OB does not work, despite being recommended.** Retested across the stated
band after their reply:

> **Superseded same day (2026-07-22 afternoon):** an OB SubmitDeposit did take
> and its cashier rendered a bank-list page. The rejections below were real at
> 12:21; treat OB as unproven, not dead. No OB payment has ever completed.

| OB amount | Result |
| --- | --- |
| 30 / 50 / 100 / 200 | `PMT10005 Invalid Transaction Amount` |
| 300 / 400 / 500 / 1000 | `PMT10024 Invalid Payment Method Routing Amount` |

`PMT10024` is a routing configuration gap on their side, not an amount problem —
no amount in the whole band succeeds. **BQR remains the only method that
returns a cashier page**, and its page still fails at QR generation. So nothing
is payable yet.

### Live smoke test — PASSED 2026-07-21

`POST /api/Merchant/CheckBalance` returned `isSuccess: true`, balance `0.00`.
Read-only, creates no transaction, and exercises the entire chain: IP whitelist,
MerchantCode, AES payload they could decrypt, RSA-SHA1 signature verified
against our uploaded public key. Use it as the first call after any key or
whitelist change.

**Envelope casing is a non-issue.** Both `{MerchantCode, Data, Signature,
Version}` (as in §1.9.2) and `{merchantCode, data, …}` (as in §1.1.2) return
200 — their model binding is case-insensitive.

## Phase 1 checklist (blocks everything else)

- [x] Generate merchant RSA 1024 keypair locally.
- [ ] Send **merchant public key** to GlobePay365 tech team.
- [ ] Give them our **server outgoing IP** for their whitelist. **Open problem:**
      `polycards-backend` runs on DO App Platform with `egress: null` — no static
      outbound IP. Needs `spec.egress.type: DEDICATED_IP` (paid DO feature) or a
      proxy with a fixed IP.
- [ ] Receive `MerchantCode` back.

## Phase 2 — integration

**Built:** `backend/packages/api/src/modules/packs/globepay.ts` — AES/RSA wire
format, envelope builder, callback opener, status mapping. Pure functions, no
container. Tests in `__tests__/globepay.unit.spec.ts`.

**Not built yet** (blocked on `MerchantCode`): the HTTP client, the pending
top-up row, and the callback route.

**Verification status:** logic checked by a standalone Node harness (AES
roundtrip, random IV, RSA sign/verify, tamper + forged-amount rejection,
status mapping) — all passing. The in-repo jest spec has **not** been run:
this workspace has no `node_modules`. CI runs it.

The doc's §1.13 AES known-answer sample is **unusable** — its published
ciphertext decodes to 244 bytes after the IV, not a multiple of the 16-byte
block, i.e. the base64 in the HTML is OCR-corrupted. No cross-implementation
vector exists; interop risk is in framing, not the math.

**Watch out — request/callback field casing differs in the doc.** The
SubmitDeposit request sample (§1.1.2) is lowercase (`merchantCode`, `data`,
`signature`, `version`); the callback (§1.2.2) is capitalized (`TransactionId`,
`Data`, `Signature`). Code follows the doc on both sides, but confirm the
request casing on the first live call — a mismatch fails silently with a
useless error.

### Flow

The real flow is **async redirect + callback**, not a synchronous swap for
`mockCharge` in `backend/packages/api/src/modules/packs/topup.ts`:

1. `POST /api/Deposit/SubmitDeposit` → returns `data.url` (cashier page).
2. Redirect the customer there; record a **pending** top-up first.
3. GlobePay365 POSTs to our `NotifyUrl` → verify signature, decrypt `Data`,
   credit the ledger.
4. Reply with the literal body `success` to stop their callback retries.

Rules to bank now:

- Verify the RSA-SHA1 signature with **their** public key before trusting any
  callback field; also allowlist the source IP (table above).
- Credit **idempotently keyed on their `TransactionId`** — reuse
  `mutateCreditAtomic` + `topupIdempotencyReference`.
- Deposit status: `6` = success, `7` = fail, `4` = verify-fail (**not final**),
  anything else = processing.
- Withdrawal status: `4` = success, `5` = fail, else processing.
- Currency for us is `MYR`. Deposit methods available for MYR: `OB`, `FPX`,
  `DN`, `BQR`. Withdrawal method is always `WD`.
- Requery endpoints exist (`/api/Deposit/GetDepositDetail`,
  `/api/Withdrawal/...`) — use them for reconciliation, never trust a lost
  callback.
- `ALLOW_MOCK_TOPUP=unsafe-demo` must come **off** the prod spec when this ships.

## Operator visibility + callback probe (added 2026-07-29)

Two gaps closed after the decision NOT to run a human scan-and-pay test before
launch. Neither replaces that test — they make an unattended launch survivable.

### Admin "Deposits" page

`GET /admin/globepay/deposits` (`src/api/admin/globepay/deposits/route.ts`) plus
`apps/admin/src/routes/deposits/page.tsx` — Orders → Deposits in the dashboard.

Read-only by design. There is no settle/requery button: the 10-minute sweep is
the authoritative repair path, and a manual credit button would be a second,
unaudited way to mint credit. Views: pending (default, OLDEST first), settled,
failed, all. A pending row older than `GLOBEPAY_STALE_AFTER_MS` is flagged
**Overdue** — same constant the sweep uses, so the page and the job can never
disagree. Overdue means the sweep has had ~6 chances to resolve that deposit and
has not: check the deposit in their back office before crediting by hand.

Before this existed, finding a stranded payment meant hand-written SQL against
production.

### `scripts/probe-globepay-callback.mjs`

```sh
node scripts/probe-globepay-callback.mjs https://admin.polycards.gg
node scripts/probe-globepay-callback.mjs            # localhost:9000
node scripts/probe-globepay-callback.mjs --self-check
```

POSTs two unverifiable bodies at `/hooks/globepay/deposit` and demands
`400 rejected`. Safe against production — an unsigned body can never pass
`openCallback`, so it cannot credit anything.

It distinguishes the failure modes that matter: UNREACHABLE (DNS/firewall/host),
NOT_DEPLOYED (404), ACCEPTS_UNSIGNED (a 2xx on junk — the route acks with
`success` to stop retries, so a broken deploy that acked everything would look
healthy to a naive check), SERVER_ERROR (500, usually missing `GLOBEPAY_*` env).

**Run it against production the moment this branch deploys, before enabling
deposits.** A missing callback is the most likely way a real payment goes
uncredited, and no spec can catch it — every spec runs against a server we
booted ourselves.

Baseline recorded 2026-07-29: `https://admin.polycards.gg` → **404 on both
probes**, as expected — PR #252 is unmerged and prod carries no `GLOBEPAY_*`
env. That is the "not deployed" reading, not a fault.

### Still open

- No human has ever paid through BQR or OB. Organic callback delivery and
  `ReturnUrl` behaviour remain unobserved.
- Alerting on pending-past-window is not built; the Deposits page shows it, but
  someone has to look.
