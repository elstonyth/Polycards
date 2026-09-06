# GlobePay365 payment gateway — setup notes (RETIRED)

> **RETIRED 2026-09-06.** Production moved to TGPay (see `tgpay-setup.md`,
> plan 130) and the GlobePay365 integration — client, AES/RSA envelope,
> callback hooks, secrets, bank codes — was removed from the codebase the
> same day. What remains: the settled rows in `globepay_deposit` /
> `globepay_withdrawal` (gateway = `globepay`, listed as history on the admin
> Settlement page), the table and route names, and the `GLOBEPAY_ENABLED` /
> `GLOBEPAY_WITHDRAWALS_ENABLED` master switches, which are gateway-neutral.
> Everything below is kept as the record of that integration. The merchant
> account itself is still open with the provider; close it when its balance
> has been settled out.

Original status line: **Phase 1 (onboarding) in progress.** No code written yet —
MerchantCode is not issued until GlobePay365 finishes back-office setup.

Source: <https://api.globepay365.com/api/globepay365_api_doc.html> (Merchant
Integration Guide v1.0.0).

> Console-side questions this document cannot answer — callback key scoping, the
> refusal/error taxonomy, and the deposits-written-off-in-error query — are tracked
> in [`docs/ops/security-verification-checklist.md`](../ops/security-verification-checklist.md).

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
| `GLOBEPAY_WITHDRAWALS_ENABLED`  | `true` to arm payouts — a SECOND switch on top of `GLOBEPAY_ENABLED`; deposits can ship without it |
| `GLOBEPAY_WITHDRAW_NOTIFY_URL`  | their POST target for payout outcomes |
| `GLOBEPAY_PAYOUT_VERIFY_URL`    | their POST target for Payout Verification — **ACTIVE on the production merchant** (portal read 2026-08-05; the "inactive" note below is the STAGING account), so the route must answer or payouts stall |
| `GLOBEPAY_CURRENCY`             | optional, defaults to `MYR` |
| `GLOBEPAY_WD_APPROVAL_ABOVE_RM` | withdrawals above this RM figure hold for admin approval instead of auto-submitting (admin `/withdrawals` queue, default view `held`); strictly greater-than, optional, defaults to `1000` |
| `GLOBEPAY_WD_DAILY_MAX_RM`      | rolling-24h cap on one customer's summed withdrawals, in RM; `0` is a deliberate stop-lever (holds every withdrawal), optional, defaults to `50000` |
| `PAYOUT_DESTINATION_COOLDOWN_HOURS` | cooling-off window (hours) between saving a payout destination and being allowed to pay out to it — the control on the steal-a-token → add-a-destination → cash-out chain; not a GlobePay-specific var, but gates the same money-out path; `0` is a deliberate opt-out, optional, defaults to `24` |

Set the withdrawal three only when payouts are meant to be live: without them
`globepayWithdrawalsEnabled()` is false and the withdrawal path fails closed —
which looks identical to "the feature is broken" if you expected it on.

Storefront (public, not secrets — set on the **polycards-storefront** app, not
the backend): `NEXT_PUBLIC_PAYMENTS_PROVIDER=globepay` switches the top-up
sheet from the mock gateway to the redirect flow; anything else keeps the mock.
`NEXT_PUBLIC_WITHDRAWALS_ENABLED=true` reveals the withdrawal form; without it
/bank-withdrawal shows the "not open yet" notice. Both mirror a backend switch
(`GLOBEPAY_ENABLED`, `GLOBEPAY_WITHDRAWALS_ENABLED`) and BOTH sides must be set
— storefront-only turns on a UI whose backend refuses, backend-only leaves a
working API nothing links to. `GLOBEPAY_NOTIFY_URL` and `GLOBEPAY_RETURN_URL` are
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
| Amount limits (TEST account) | Min **RM 30**, max **RM 1000** (Bryan) |
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
- [x] Send **merchant public key** to GlobePay365 tech team. (Production key
      sent 2026-07-29; the string in their thread is byte-identical to
      `~/.secrets/globepay/merchant_public_prod.pem`, re-verified 2026-07-30.)
- [x] Give them our **server outgoing IP** for their whitelist. Solved with
      `spec.egress.type: DEDICATED_IP` — see "Egress is spec state, and it can be
      wiped" below before touching it.
- [x] Receive `MerchantCode` back — `Polycard` (in `.do/backend.app.yaml`).
      Not yet exercised against the live host; the first `CheckBalance` proves it.

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
  callback field. The signature is the ONLY gate: we deliberately do **not**
  allowlist the callback source IP. Behind DO's load balancer the address we
  observe is not theirs, so an IP gate would reject genuine settlement callbacks
  — losing money to defend something the RSA check already covers.
  `GLOBEPAY_CALLBACK_IPS` in `globepay.ts` records their egress addresses for
  reference (it is what you give THEM, and what to expect in their logs); it is
  intentionally not wired into any route.
- Credit **idempotently keyed on the signed `Data.MerchantTransactionId`** —
  reuse `mutateCreditAtomic` + `topupIdempotencyReference`. NOT the top-level
  `TransactionId`: only `Data` is covered by the RSA signature, so every other
  field is attacker-mutable on a captured callback. Anchoring on `TransactionId`
  would let one genuine callback be replayed with a fresh value each time, each
  replay minting another credit. `TransactionId` is a human-facing
  reconciliation handle only. The deposit hook already does this — see the note
  above `const merchantTransactionId` in
  `src/api/hooks/globepay/deposit/route.ts`.
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

### Organic callback delivery — OBSERVED, AND IT WAS BLOCKED (2026-08-11)

Real customers have now paid, and the callbacks are real: GlobePay POSTs to the
exact `NotifyUrl` we send per request, from `13.159.14.239` (AS16509 Amazon,
Japan — the production address in the table at the top of this file), with an
**empty user agent**, retrying roughly every 1–5 minutes.

Not one of them reached the origin. Cloudflare's **Bot Fight Mode** answered each
with a **Managed Challenge**, which a webhook cannot solve:

```
Service: Bot fight mode        Action: Managed Challenge
POST admin.polycards.gg /hooks/globepay/deposit    IP 13.159.14.239
```

Eight challenges between 14:53 and 15:08 GMT+8 for one RM 500 deposit; the
backend logged zero `/hooks/globepay/deposit` requests over the same 13 hours
in which it logged eight `/store/credits/deposit` starts. Every top-up was
therefore credited by the reconciliation sweep instead, which is exactly what
the sweep's "credited … from a REQUERY, not a callback" warning is for — the
customer's wait became the sweep interval.

Fix applied the same day: the three server-to-server URLs
(`GLOBEPAY_NOTIFY_URL`, `GLOBEPAY_WITHDRAW_NOTIFY_URL`,
`GLOBEPAY_PAYOUT_VERIFY_URL`) now point at the app's own origin hostname,
`https://polycards-backend-gce6p.ondigitalocean.app`, which Cloudflare does not
front. On the free plan Bot Fight Mode is zone-wide and cannot be excepted
per-path by a WAF skip rule, so moving the callbacks off the proxied hostname is
the narrow fix; disabling Bot Fight Mode for the whole zone was the alternative.
No security is lost — these routes authenticate the RSA signature over their AES
payload and have never trusted the edge or the source IP.

**Diagnostic worth keeping:** an absence of hook requests in the DO logs does NOT
mean they never sent. Check Cloudflare → Security → Analytics → Events before
concluding anything about their side.

### Still open

- No human has ever paid through BQR or OB. `ReturnUrl` behaviour remains
  unobserved.
- Alerting on pending-past-window is not built; the Deposits page shows it, but
  someone has to look.

## Production limits — confirmed by Sean, 2026-07-29

These are the LIVE account's, and they are not the test account's. Both bands
are enforced in the storefront and again in the backend so an impossible amount
never costs a round-trip.

| Flow | Method codes | Min | Max |
| --- | --- | --- | --- |
| Deposit — Online Banking, bank to bank | `OB` | RM 30 | RM 10,000 |
| Deposit — QR / e-wallet | `BQR` | RM 30 | RM 10,000 |
| Payout | `WD` | **RM 50** | RM 50,000 |

Two things to notice. The payout FLOOR is higher than the deposit floor (50 vs
30) — they are separate bands, not one shared band, which is why
`GLOBEPAY_WD_MIN_RM` no longer mirrors `GLOBEPAY_MIN_RM`. And the deposit
ceiling now coincides exactly with the site-wide `TOPUP_MAX_RM` (RM 10,000),
which is checked first, so an over-ceiling top-up is refused with the site's
wording and the gateway band effectively only guards the floor. Both checks
stay: one answers to us, the other to them, and they can move apart again.

Storefront presets follow the wider band: RM 50 / 250 / 500 / 5,000. The old
30/50/100/200 rungs hugged a RM 1,000 ceiling that no longer exists.

Still stated rather than verified: nobody has submitted RM 10,000 or RM 50,000
against the live account. Re-probe the edges once the gateway is armed — the
test account's stated max turned out to be exact (1000 accepted, 1001
`PMT10005`), so theirs are probably right, but "probably" is not a receipt.

## Production cutover (written 2026-07-29, NOT yet executed)

The account handover moved us from the `Testpolycard` staging merchant to the
live one. Nothing below is done automatically — the secret values are pasted by
a human into the DigitalOcean app, never into this repo.

### Blockers, in order. Each one stops the next.

1. **Rotate the back-office password.** It was pasted into a chat transcript.
   Ask GlobePay to reissue the AES key at the same time, for the same reason.
2. **Generate the production RSA keypair locally** (`openssl genrsa … 1024`,
   §"Secrets" above) **outside the repo** — `.pem` is not gitignored. Do NOT use
   devglan.com or any other web tool, whatever their onboarding mail says: that
   private key signs payout requests, so a key that ever touched a third-party
   site is a drain-the-balance risk. Send them the **public** half only.
3. **Give them our outgoing IP, and have one to give.** DONE — `polycards-backend`
   now carries `spec.egress.type: DEDICATED_IP`, one address per component.
   Without it the app has no static outbound address while their account has
   `IP Whitelist Check: Active`, so **every API call from production is
   rejected** and no env var fixes it. Read the next section before you touch
   the spec: this setting has already been lost once.
4. **Both whitelists — and GlobePay has to do them.** Their `Setting →
   Whitelist Setting` has a BackOffice list (who may log in) and an API list
   (which servers may call). Confirmed 2026-07-29: the production account
   enforces the BackOffice list and our address is NOT on it — the login page
   answers `Access Denied: Your IP address is not authorized to perform this
   action`. So we cannot reach the portal to add the API entries ourselves;
   both lists have to be set by them. Send: our office IP for the BackOffice
   list, and BOTH server IPs — **`188.166.181.61`** and **`188.166.181.204`** —
   for the API list. One IP per component: the service takes customer traffic,
   the worker runs the reconciliation sweeps, and whitelisting only one means
   live payments work while the sweep that catches a dropped callback fails
   silently. Note the office IP is likely dynamic; ask whether they can allow a
   range.

   These are the **only** addresses to send. `206.189.94.252` /
   `168.144.35.100` were the original pair and are DEAD — DigitalOcean released
   them on 2026-07-30 (see below). They are named here only so you recognise
   them as stale if GlobePay quotes them back; sending them again re-creates the
   outage. Before sending, re-read the live values rather than trusting this
   file: `doctl apps get 7fd66ea2-0105-420b-87eb-8a4606262561 -o json` →
   `dedicated_ips`.

   **BackOffice list: DONE**, per GlobePay 2026-07-30 ("都已设置好了") and
   independently verified — `https://backoffice.globepay365.com/` now answers
   `200` from the office with no `Access Denied` body, where 2026-07-29 it
   refused. Office IP `60.48.37.10`.

   **API list: SET, BUT ON THE WRONG ADDRESSES.** They whitelisted
   `206.189.94.252` / `168.144.35.100` as asked. Those IPs were released hours
   later (see the next section) and production now egresses from
   **`188.166.181.61`** and **`188.166.181.204`**. The new pair has to be sent
   and confirmed before deposits are armed, or every call is rejected. This half
   cannot be verified from the office at all — only the server addresses may
   call — so its first proof is `CheckBalance` from production.

   **DONE and PROVEN 2026-08-06.** GlobePay confirmed the new pair, and
   `CheckBalance` now succeeds from **both** components — each one from its own
   dedicated address, verified in the same session by reading `api.ipify.org`
   from inside the container:

   | Component | Egress IP          | CheckBalance                                                          |
   | --------- | ------------------ | --------------------------------------------------------------------- |
   | `backend` | `188.166.181.204`  | OK — `{"merchantCode":"Polycard","currencyCode":"MYR","currentBalance":0,…}` |
   | `worker`  | `188.166.181.61`   | OK — same payload                                                     |

   Testing both is the point, not a formality: one IP per component, and a green
   `backend` with a dead `worker` means live payments work while the reconcile
   sweep that catches a dropped callback fails silently.

   **The 2026-08-05 diagnosis in the previous revision of this block was wrong,
   and it is worth knowing why.** It read the `PMT10006` refusals as the API
   whitelist rejecting us before the payment method was consulted, and concluded
   "the channels were never the problem, do NOT rotate methods again." The
   whitelist is now green on both addresses — so if `PMT10006` survives, it is
   the channel after all and that instruction is actively misleading. Two
   traps that produced the bad read:

   - **`PMT10006` was never consistent with an IP rejection.** It is a parseable
     `PMT*` code at HTTP 400, which is exactly the case
     `check-globepay.ts` itself labels "credentials are fine and the
     account/config is the problem". The error shape was in the log the whole
     time and contradicted the theory.
   - **An unauthenticated probe cannot test the whitelist.** A malformed
     `POST /api/Merchant/CheckBalance` returns the identical ASP.NET
     `400 application/problem+json` from an allowlisted server and from a random
     office machine. Their IP check lives inside the signed merchant call, not
     at the edge, so the only valid test is a real signed `CheckBalance` — which
     is the whole reason `check-globepay.ts` exists. Do not substitute a curl.

### Deposits were dead ACCOUNT-side — FIXED by GlobePay 2026-08-06

**RESOLVED.** Support ("Mizuki") replied `可以再尝试充值 已完成设定` at 12:57 MYT
(04:57 UTC) on 2026-08-06, and the very next top-up from the storefront reached a
real cashier page: DuitNow QR, `MYR 50.00`, their order `304-MY05-218-26-913`,
5-minute expiry. `PMT10006` is gone. The diagnosis below is kept because it is
what was sent to them and what got it fixed — read it as history, not as the
current state.

What is still true from it: `BQR` and `OB` are the only provisioned deposit
channels (`DN` and `FPX` are known codes with nothing behind them). Re-checked
against `GetSupportedBanks` after the fix, and the storefront's picker list
(`src/lib/deposit-methods.ts`) is built from exactly that.

<details>
<summary>The 2026-08-06 pre-fix diagnosis (what was sent to support)</summary>

With the whitelist green, `SubmitDeposit` was re-run from production across every
axis. **Every single combination returned `PMT10006 Invalid Payment Method`:**

| Axis swept                                      | Result                        |
| ----------------------------------------------- | ----------------------------- |
| Method `BQR`, `OB`, `DN`, `FPX`                  | all `PMT10006`                |
| `BQR` + its one bank (`MYRHBB`)                  | `PMT10006`                    |
| `OB` + `MYAFBB` / `MYBMMB` / `MYCIMB`            | `PMT10006`                    |
| Amount `30` / `50` / `100` / `500`               | `PMT10006`                    |

And it is **not** that the method codes are unknown to them. `GetSupportedBanks`
(plain GET, no signature) answers for exactly the codes the back office lists,
and refuses everything else with a *different* message:

| `PaymentMethodCode` | GetSupportedBanks                                    |
| ------------------- | ---------------------------------------------------- |
| `BQR`               | `200`, 1 bank (`MYRHBB`)                             |
| `OB`                | `200`, 7 banks (Affin, Muamalat, CIMB, HLB, Maybank, Public, RHB) |
| `WD`                | `200`, 31 banks                                      |
| `DN`, `FPX`         | `400 Not found` — known code, nothing provisioned    |
| `QR`/`TNG`/`CARD`/… | `400 Invalid Payment Method` — unknown code          |

So their system knows `BQR` and `OB` for merchant `Polycard`, has banks mapped to
both, and still refuses to open a deposit on either. Signed calls succeed
(`CheckBalance` returns the balance), so this is not credentials, not the AES
key, not the RSA signature, not the IP, and not `GLOBEPAY_DEPOSIT_METHOD`.

**Conclusion: the deposit side of the production merchant is not enabled for the
API. Only GlobePay support can fix it.** Give them the table above — it is the
whole diagnosis. Do not rotate `GLOBEPAY_DEPOSIT_METHOD` again; four values,
four bank codes and four amounts have now been eliminated.

(That conclusion was correct: they enabled it, and nothing on our side changed.)

</details>

### The customer picks the channel (2026-08-06)

Both live channels are now offered in the top-up sheet instead of one being
pinned server-side. `POST /store/credits/deposit` had always accepted
`payment_method_code`; the storefront simply never sent it, so every customer
landed on whatever `GLOBEPAY_DEPOSIT_METHOD` named — a DuitNow QR they could not
swap for online banking.

- `src/lib/deposit-methods.ts` — the two provisioned channels and their labels,
  with the `GetSupportedBanks` evidence for why `DN`/`FPX` are absent.
- `src/components/app-shell/TopUpSheet.tsx` — the picker (gateway branch only;
  the mock gateway has no channels).
- `src/lib/actions/vault.ts` — `startDeposit(amount, method)`.

`GLOBEPAY_DEPOSIT_METHOD` is now only the fallback for a request that names no
method — which storefront traffic never is, so changing it no longer moves what
customers get. Adding a channel means proving it with `GetSupportedBanks` first:
the backend allow-list is the gateway's whole MYR set, so an un-provisioned code
would pass validation and fail at the cashier.

**Retracting a channel: `DEPOSIT_METHODS_ENABLED` on the storefront app.**
Comma-separated codes; `BQR` pulls online banking back to QR-only. Unset (the
default — the spec deliberately does not carry the key) means every provisioned
channel, and so does a value naming nothing recognised, which also logs an
error: a typo must not leave customers unable to pay. `GLOBEPAY_ENABLED` on the
backend remains the switch that stops top-ups entirely.

Two things about **where** it is read, both load-bearing:

- Not a `NEXT_PUBLIC_*`. Those are inlined at build time (here from a Dockerfile
  `ARG`), so a picker driven by one could only be retracted by rebuilding the
  storefront image.
- Not read in the root layout either, which is the subtler trap: `/task`,
  `/about`, `/how-it-works` and friends are fully prerendered, so a
  layout-resolved list is frozen into their flight payload at **build** time —
  the switch would work on dynamic routes and silently do nothing on static
  ones. The sheet calls the `getDepositMethods` action when it opens, which runs
  per request everywhere.

`startDeposit` re-checks the code against the same runtime set, so a stale
client bundle cannot route around the switch. A customer JWT posting straight to
`POST /store/credits/deposit` still can — the backend allow-list is the
gateway's whole MYR set — but that only buys them a cashier that refuses.

**`OB` is offered but NOT yet proven.** Only `BQR` has been seen to reach a
cashier page since support enabled deposits; `OB` rests on their `已完成设定`
plus a `GetSupportedBanks` 200 — and that same 200 was returned all through the
outage, while every OB deposit was refused. The first live OB top-up settles it:

| What the cashier renders | Meaning |
| ------------------------ | ------- |
| Bank / FPX-style selection page | `OB` is live — done |
| A DuitNow QR page again  | the deployed backend ignored `payment_method_code` and fell back to `GLOBEPAY_DEPOSIT_METHOD` |
| An error in the sheet    | `OB` is still shut account-side — send support the same table as before, naming `OB` |

No `SourceClientBankCode` is sent for either channel. That is an assumption, not
a measurement: the field is documented mandatory for `BMR` only, so their cashier
is expected to collect the bank for `OB`. If the OB page appears with no bank
list, add a picker fed by `GetSupportedBanks` and thread the code through
`startGlobePayDeposit` — the client already accepts it.

**Withdrawals are the mirror image: the channel IS live.** `WD` returns 31 payout
banks and Payout Verification is active on this merchant. But payouts draw on the
merchant balance, and `currentBalance` / `availableBalance` / `t1Balance` are all
`0` — and the only thing that funds them is deposits. So money-out cannot be
proven until money-in works, no matter what the withdrawal switches say.

### How to actually run the preflight on production

`CheckBalance` only proves anything from a dedicated egress IP, so it has to run
*inside* the container. Two things block the obvious route:

1. **`doctl apps console` needs a real terminal.** It puts the local TTY into raw
   mode, so under anything whose stdout is a pipe — an agent harness, the VS Code
   terminal, CI — it dies with `error getting terminal size: The handle is
   invalid`, and there is no flag to opt out. Use `scripts/do-exec.mjs`, which
   talks to the same console WebSocket directly (envelopes are
   `{"op":"stdin"|"stdout","data":"…"}`; sending a bare string closes it 1006):

   ```sh
   node scripts/do-exec.mjs 7fd66ea2-0105-420b-87eb-8a4606262561 backend \
     'node node_modules/@medusajs/cli/cli.js exec ./src/scripts/check-globepay.ts'
   ```

   `medusa` is not on `PATH` in the image and not in `node_modules/.bin` — the
   CLI is `node_modules/@medusajs/cli/cli.js`. Container workdir is
   `/app/packages/api`. There is no `curl`; use `node -e "fetch(…)"`.

2. **`medusa exec` OOMs the worker.** `worker` is `basic-xxs` (512 MB) and
   already runs a Medusa process; booting a second one gets the pod's sandbox
   killed mid-run (`containerManager.WaitPID failed: EOF`). A heap cap does not
   save it. `globepay-client` imports nothing from the framework, so call it
   bare instead — same network path, no container boot:

   ```sh
   node scripts/do-exec.mjs 7fd66ea2-0105-420b-87eb-8a4606262561 worker \
     'node -e "const c=require(\"/app/packages/api/.medusa/server/src/modules/packs/globepay-client.js\");c.checkBalance(c.globepayConfigFromEnv()).then(b=>console.log(\"OK \"+JSON.stringify(b))).catch(e=>console.log(\"FAIL codes=\"+(e.codes||[]).join(\",\")+\" http=\"+e.httpStatus))"'
   ```

Confirm which address you actually tested — `dedicated_ips` does not say which
component holds which. From inside: `node -e "fetch('https://api.ipify.org')…"`.

### Egress is spec state, and it can be wiped (learned the hard way 2026-07-30)

`doctl apps update` replaces the **entire** app spec. A spec with no `egress`
block does not leave the dedicated IPs alone — it releases them.

That is what happened on 2026-07-30. Deployment `f7b19e3b` (09:39 UTC) went out
with `egress: {"type":"DEDICATED_IP"}`; `2779c7a6` (09:46 UTC, "app spec
updated") went out with `egress: null`, because the spec applied was master's
and only this branch carried the block. `dedicated_ips` read back `null`
afterwards. Thirty minutes earlier GlobePay had confirmed the API whitelist for
exactly those two addresses.

**The failure is silent.** The app stays `ACTIVE`, `/health` passes, the
storefront is fine. The only thing that breaks is outbound calls to GlobePay —
so with the gateway armed, it would have surfaced as a customer paying and
never being credited, not as an alarm.

Fixed by putting the block in master's `.do/backend.app.yaml` (PR #302), so any
future `do-apply backend` preserves it, then re-applying to restore egress
(deployment `3de62783`, ACTIVE 2026-07-30).

**The addresses did not come back.** DO allocated a fresh pair rather than
returning the released ones:

| | Whitelisted by GlobePay | Live after the restore |
| --- | --- | --- |
| | `206.189.94.252` | `188.166.181.61` |
| | `168.144.35.100` | `188.166.181.204` |

So the wipe cost the whitelist, not just the setting. Treat "toggled egress off"
as "burned those IPs" — they are not reserved and you do not get them back.

Standing rule:

> After **any** change that touches egress, read the addresses back —
> `doctl apps get 7fd66ea2-0105-420b-87eb-8a4606262561 -o json` →
> `dedicated_ips` — and compare to what GlobePay has. A reallocation is
> invisible from our side and un-whitelisted from theirs.

### Then the spec update — committed IaC, not the DO UI

The variables are **already written** into `.do/backend.app.yaml` and
`.do/storefront.app.yaml` (this branch). Nothing is typed into the DO console —
that causes drift, and `scripts/do-apply.ps1` treats the committed spec as the
source of truth.

What you supply is three secret values in the gitignored `deploy/.env.deploy`:

    GLOBEPAY_AES_KEY=<their AES key>
    GLOBEPAY_PUBLIC_KEY=<their RSA public key, bare base64 body, ONE line>
    GLOBEPAY_MERCHANT_PRIVATE_KEY=<our private key, bare base64 body, ONE line>

Two of the three still have to come **from GlobePay** — the AES key and their
public key. Only `GLOBEPAY_MERCHANT_PRIVATE_KEY` is ours (in
`~/.secrets/globepay/merchant_private_prod.pem`), and as of 2026-07-30 none of
the three are in `deploy/.env.deploy`.

Ask for the AES key **reissued**, per blocker 1: the value handed over came
alongside a back-office password that was pasted into a chat transcript. Pasting
the pre-rotation key into production puts a chat-exposed secret on the money
path.

Bare base64 **body only** for both keys — no `-----BEGIN-----` armor and no
newlines. `packs/globepay.ts` `toPem()` re-wraps them, a multi-line value would
break the YAML, and `do-apply` substitutes literally. Get our private key's body
with:

    (Get-Content "$env:USERPROFILE\.secrets\globepay\merchant_private_prod.pem" | Where-Object { $_ -notmatch '^-----' }) -join ''

Then:

    pwsh scripts/do-apply.ps1 backend -Validate   # no live change
    pwsh scripts/do-apply.ps1 backend             # REDEPLOYS production

`do-apply` aborts if any `__SECRET__` placeholder is still unresolved, so a
missing value fails loudly instead of pushing a redacted string to production.

**Order matters, and the spec enforces it by being wrong until the merge.** The
committed spec has `ALLOW_MOCK_TOPUP` REMOVED and the GlobePay vars ADDED. Apply
it before PR #252 merges and customers get a storefront whose deposit route does
not exist; apply it after, and it is exactly right — the boot guard now refuses
to start production with `ALLOW_MOCK_TOPUP` set to any value at all. So: merge,
then apply, in that window.

**The storefront switch is a code change, not a variable.** Next inlines
`NEXT_PUBLIC_*` at build time and App Platform does not reliably pass build-time
env, so the root `Dockerfile`'s `ARG NEXT_PUBLIC_PAYMENTS_PROVIDER` default is
what actually lands in the bundle. It ships as `mock`. The cutover is a one-line
commit changing it to `globepay`, with the matching value in
`.do/storefront.app.yaml` moved in the same commit. Flipping the spec alone
leaves every customer on the mock sheet.

Withdrawals stay off for the first cutover; the vars to add later are listed
inline in the backend spec.

### Verify, in this order

1. `node scripts/probe-globepay-callback.mjs https://admin.polycards.gg` —
   demands a 400 on two unsigned bodies. A 404 means the route did not deploy;
   a 2xx means it is acking junk. Run it BEFORE telling anyone deposits work.
2. `POST /api/Merchant/CheckBalance` from the production host — read-only, and
   it exercises the whole chain: whitelist, MerchantCode, AES, RSA signature.
3. **One human scan-and-pay through BQR.** No spec can replace it: every test
   in this repo runs against a server we booted ourselves, and nobody has ever
   completed a payment through this gateway on any environment. Watch the
   deposit land in Orders → Deposits and the matching `TP` row in the ledger.
