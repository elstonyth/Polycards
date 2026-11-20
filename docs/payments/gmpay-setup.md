# GMpay (Singapore, SGD) setup

GMpay (the PayFlowXZ platform, API v3) is the Singapore rail since 2026-11-19, replacing A3Pay ([a3pay-setup.md](a3pay-setup.md)). Like A3Pay it is a **regional rail** beside the active RM gateway:

- **Top-ups.** Customers choose **Pay in S$** on the top-up sheet and pay by PayNow QR (`BQR` → contract `SGD_PAYNOW`) or online banking (`OB` → `SGD_ONLINEBANKING`). They are credited RM at today's rate minus the S$ top-up fee (Settlement → S$).
- **Withdrawals.** A saved Singapore bank account at a bank GMpay serves is paid in SGD (`SGD_BANKTRANSFER`) at today's rate plus the S$ payout fee.
- **Ledger and fences stay in RM.** Each row locks its quote (`currency`, `gateway_amount`, `fx_mid`, `fx_markup`), and callbacks, sweeps and the audit convert through that lock. The FX and fee mechanics are the same as A3Pay's: see that doc's "The conversion and the fee".

API doc: <https://xapi.payflowxz.com/v3/doc>. Code:

- `modules/packs/gmpay-client.ts`: signing, the HTTP client and callback verification.
- `gateway.ts`: the `gmpay` registry entry and adapter.
- `api/utils/gmpay-hooks.ts`, `api/hooks/gmpay/*`: the callback handlers.
- `api/utils/payer-name.ts` (`payerAccountOnFile`): which saved account a pay-in declares.

## What is different from A3Pay

- **Every pay-in declares the paying account**: holder name, bank and account number. The deposit route takes the bank and number from the customer's **saved** accounts at a bank GMpay serves (holder matching the payment's name first, then the real name, then the newest). With none saved, the top-up is refused before any row: "Save the bank account you pay from first, on the Withdraw page."
- **Lookups take GMpay's own token only** (`payinQuery` / `payoutQuery` by `tran_token`), never our `PC-…` reference. `lookupNeedsGatewayId` in the registry makes the code that would ask first decide from what it already knows:
  - A payout GMpay refuses as creating nothing (`INVALID_IP`), or refuses for an empty wallet our balance read confirmed, is refunded at once (`refundsWithoutLookup`, withdrawal-submit.ts). Any other refusal stays held for a human.
  - The gateway audit stamps a row with no token without asking; a **settled** one becomes the finding "settled without the gateway id".
- **No amount nudge** (`payinNudgeCents: 0`): a pay-in at any other sum than the one locked is refused, and status checks read `tran_actual_amount` when GMpay reports it.
- **Refusals are HTTP 200** with `{"status_code": -1, "status_msg": "…"}`, never a 4xx.
- **Callbacks.** Pay-in callbacks fire on success only, so failed or expired pay-ins are found by the deposit sweep. Payout callbacks fire on completed and rejected. Each answer must be the literal `OK`. Callbacks are verified against the raw body (`preserveRawBody`), must carry the token we stored, and must come from `GMPAY_CALLBACK_IPS` (default `149.104.77.131`).

## Signing

`tran_signature = sha256(k1=v1&k2=v2&…<secret>)`: every non-empty field except the signature, keys sorted, values as sent, the Secret Key appended with no separator. `gmpay-client.unit.spec.ts` reproduces the doc's own example vector.

## Configuration

| Env | Value |
| --- | --- |
| `GMPAY_ENABLED` | `"true"` opens the rail (with `GATEWAY_ENABLED`). |
| `GMPAY_API_BASE` | `https://xapi.payflowxz.com/v3` (https required; loopback http only for a mock). |
| `GMPAY_CLIENT_ID`, `GMPAY_SECRET_KEY` | SECRET, from `deploy/.env.deploy`. |
| `GMPAY_CURRENCY` | `SGD`. |
| `GMPAY_CALLBACK_IPS` | `149.104.77.131`. |

**Staging and production share one host.** Only the Client ID and Secret Key tell them apart, so a mix-up cannot be caught by the URL: check the keys against the back office of the merchant you mean (production: `GM_POLYCARDS`).

The keys live in the back office: Admin → My Profile → API Information → API Authentication. Logging in needs an OTP that GMpay sends on request, so the operator logs in, never an agent.

GMpay allow-lists the caller's IP **per merchant**. Production calls leave from the backend app's two dedicated egress IPs, `188.166.181.61` and `188.166.181.204`; both must be on the production merchant's list. Every call from anywhere else answers `INVALID_IP`.

## Checking it from production

The read-only probe runs inside the production worker so its calls leave from the whitelisted IPs: balance, the SGD bank list, lookups of unknown tokens, a bad signature. It needs no deploy. See the session scratchpad scripts `gmpay-remote-probe.mjs` and `gmpay-run-remote.cjs` (do-exec over `scripts/do-exec.mjs`, config injected and deleted, shell history off).

## Open with GMpay

- Whether SGD amounts take cents (the doc lists `tran_amount` as "Integer"; payouts are converted from RM and almost always have cents).
- Production fees and min/max (the registry limits are copied from A3Pay).
- Which payout refusals create nothing, beyond `INVALID_IP`.
