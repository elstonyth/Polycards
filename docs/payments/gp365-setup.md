# GlobePay365 (USDT) setup

GlobePay365 is our **USDT rail**. It is a second **regional rail**, beside the active RM gateway and beside A3Pay (SGD). Everything [a3pay-setup.md](a3pay-setup.md) says about regional rails applies here too: the RM ledger, the per-row FX lock, the markup taken both ways, the quoted-rate guard, and the payout-float breaker.

- **Same platform as A3Pay.** GlobePay365's API doc (<https://api.globepay365.com/api/globepay365_api_doc.html>, read 2026-10-12) is A3Pay's handbook under another name. It has the same endpoints, the same AES/RSA envelope and the same status numbers.
  - The code therefore runs A3Pay's client, adapter and hook handlers bound to GlobePay365's own keys and rows, the way The 7 Pay reuses TGPay's.
  - The tenant table is `A3PAY_FAMILY` in `modules/packs/a3pay-client.ts`.
  - The gateway id is **`gp365`**, and the env prefix is `GP365_`.
- **Not the retired `globepay`.** That id names the old MYR merchant's rows (`RETIRED_GATEWAYS`), which must stay history. If it were reused, the sweeps would start requerying old rows against the new merchant.
- **Top-ups.** The customer chooses **Tether** on the top-up sheet and pays in USDT on TRC20 (`UTRC`) or ERC20 (`UERC`). No payer name is sent; the doc requires one for SGD only.
- **Withdrawals.** A saved **USDT wallet** is paid in USDT. The wallet types are `USDTTRC20` and `USDTERC20`, both in `USDT_WALLETS` in `banks.ts`.
  - The "account number" is the wallet address.
  - Tron addresses are checked with their base58 checksum. ERC20 addresses are checked with their EIP-55 checksum (keccak-256 via `@noble/hashes`). An ERC20 address written in one case carries no checksum, so it is accepted on its shape alone. The server is the only judge; the storefront just needs something pasted and shows the server's message.
  - A wallet has no holder name. Per the doc, `ToClientAccountHolderName` is sent as our customer id (`MCustId`).
  - The payout bank code is `USDTTRC` or `USDTERC`.
- **The rate.** Hourly from Coinbase's USDT→MYR (`currency=USDT`). When Coinbase fails, frankfurter's **USD→MYR** is the proxy (USDT tracks the dollar), and the job accepts its USD label only for that fallback (`fallbackQuotes`). A manual rate overrides both if USDT trades off its peg, and a manual rate never ages out. Set the fee (on/off, top-up %, withdrawal %) in **Admin → Settlement → USDT tab → Exchange rate**. A new `USDT_MYR` row has no fee saved (`fee_enabled` NULL), which keeps the rail **paused** until an admin saves one. The fee is a percent of the market rate, the same rule as S$: top-up M × (1 − fee%), withdrawal M × (1 + fee%). The target is **0.5% each way** (M 4.20 → 4.179 in, 4.221 out). Never enter an old absolute RM markup converted into a percent.

## Onboarding (the GlobePay365 message)

1. **Merchant RSA key.** Generate it locally. Never use the online generator the message links to.

   ```bash
   node scripts/a3pay-keygen.mjs --gateway gp365 --bits 1024
   ```

   - The private key goes into `.env` as `GP365_MERCHANT_PRIVATE_KEY` and is never printed.
   - The public key is saved to `docs/payments/gp365-merchant-public-key.txt` (or `--public-file`). **Send that to GlobePay365.**
   - They ask for 1024-bit keys.
   - Two pairs, both generated 2026-10-12:
     - **Staging:** the private key is in the local backend `.env`; the public key is `gp365-merchant-public-key.staging.txt`.
     - **Production:** the private key is in the gitignored deploy secrets file that `scripts/do-apply.ps1` reads. It is inert until `GP365_MERCHANT_PRIVATE_KEY` is added to that script's secret list. The public key is `gp365-merchant-public-key.production.txt`. **Back the private key up** (password manager or DO): it exists only on this machine.

     ```bash
     node scripts/a3pay-keygen.mjs --gateway gp365 --bits 1024 --env-file <deploy secrets file> --public-file docs/payments/gp365-merchant-public-key.production.txt
     ```
2. **IP whitelist.** Send our egress IPs:
   - For staging probes from the office: the office IP.
   - For production: the backend egress IPs `188.166.181.61` and `188.166.181.204`.
3. **Read from the back office** (log in yourself). The doc states none of these:
   - The MID / MerchantCode. The login id may not be the MID.
   - The USDT limits and fees.

## Env (backend service + worker)

| Var                          | Value                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `GP365_ENABLED`              | `true` to open the rail                                                                      |
| `GP365_API_BASE`             | `https://mapi.globepay365.com` (staging: `https://mapi.globepay365stg.com`)                  |
| `GP365_MERCHANT_CODE`        | MID from the back office                                                                     |
| `GP365_AES_KEY`              | secret, from GlobePay365                                                                     |
| `GP365_MERCHANT_PRIVATE_KEY` | secret, ours (PKCS#8 base64)                                                                 |
| `GP365_PUBLIC_KEY`           | GlobePay365's public key (X.509 base64)                                                      |
| `GP365_CALLBACK_IPS`         | optional; defaults to production's `13.159.14.239`. Staging: `160.250.92.219,13.159.14.239` (the doc names the first, their onboarding message the second; the signature is the real gate). |
| `GP365_CURRENCY`             | optional; defaults to `USDT`                                                                 |
| `FX_USDT_MYR_URL`            | optional; the feed, default Coinbase `currency=USDT` (frankfurter USD→MYR is the fallback)   |

GlobePay365 sends callbacks to `PAYMENT_CALLBACK_BASE` plus these paths:

- `/hooks/gp365/deposit`
- `/hooks/gp365/withdrawal`
- `/hooks/gp365/payout-verify`

No migration is needed: the gateway column is plain text, and the FX-lock columns came with A3Pay.

**Preflight**, read-only, from `packages/api`:

```bash
./node_modules/.bin/medusa exec src/scripts/check-a3pay.ts gp365
```

It checks the following:

- **Balance:** proves the base URL, keys, MID and IP whitelist together.
- **Payout bank list:** the codes must include `USDTTRC` and `USDTERC`.
- **Requery not-found:** a requery for an unknown reference must read as not-found, because that answer is what authorises a stale refund.

## Local end-to-end test

```bash
node scripts/a3pay-mock.mjs --tenant gp365 --backend http://127.0.0.1:9000
node scripts/gp365-e2e.mjs
node scripts/gp365-e2e.mjs payouts
```

- Start the backend with `%TEMP%\gp365-mock.env` layered over its env (plus `GATEWAY_ENABLED`, `GATEWAY_WITHDRAWALS_ENABLED`, `PAYMENT_CALLBACK_BASE` and `PAYOUT_DESTINATION_COOLDOWN_HOURS=0`).
- Run the payout legs for a customer whose deposits are played through.

## Open before go-live

- **USDT limits.** The `currencyLimits` in `gateway.ts` (deposit 10–2,000, payout 10–5,000) are **placeholders**. Replace them with the back-office settings. Keep the RM `limits.withdrawalMin` (RM 30) below the USDT floor at today's rate, so the USDT floor is the one that binds.
- **Nudge window.** `payinNudgeCents: 100` lets a payin move up to 1 USDT from what we asked and still re-lock at the same rate. Staging never moved an amount (a 10 USDT order stayed 10 in CreatePayin and GetPayinDetail), so the window is probably unused; it is harmless either way.

## Proven on staging (2026-10-20)

Run from the office (egress IP 60.48.37.75, whitelisted by GlobePay365 that day; the earlier 60.48.37.10 answered every signed call with HTTP 403). The worktree backend was pointed at staging with `GP365_MERCHANT_CODE=TestpolycardUSDT` (the dotenv file lacks the MID).

- **Preflight** green: balance in USDT, payout codes `USDTERC` / `USDTTRC` match ours, and an unknown reference reads as **"Not found"** on both requery endpoints.
- **A wrong IP or key is HTTP 403**, which we classify as ambiguous, never as not-found, so it cannot authorise a refund.
- **Top-up:** CreatePayin for 10 USDT TRC20 returned order D2026102012416935 and a hosted cashier on `cashier.globepay365stg.com`. Unpaid, it showed "Payment Timeout" within minutes and GetPayinDetail read status 4 (Verify Fail). After GlobePay365 approved it by hand (staging cannot be paid), our deposit sweep credited RM 41.79 from the requery within seconds (net equal: staging fee 0). The callback cannot reach a local backend, so the callback path is still unproven on staging.
- **Payout:** SubmitPayout for 10 USDT to a TRC20 wallet returned W2026102002371683 at status 6 "Unknown", the balance reserved. Like A3Pay, GlobePay365 posts payouts by hand.
- **A different amount is not a payment** (GlobePay365, 2026-10-20): if the USDT that arrives differs from the order (e.g. order 10, pay 9), they treat the order as **unpaid** (status 4), and both the callback and GetPayinDetail keep showing the **order** amount, never what arrived. They resolve it by hand. So we never credit a short or over payment, and if they mark one successful, the record still says the order amount and we credit the full order: they must only do that once the full amount has arrived. The storefront tells the customer to send exactly the amount shown, exchange fee included.

## Still open before go-live

- the callback on production (signature, `Amount`, source IP);
- the production fee and limits (staging: 1–1,000 USDT, fee 0);
- the production cashier's payment window (staging times out within minutes).
