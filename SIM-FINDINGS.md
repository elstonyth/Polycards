# Virtual-Month Simulation — Findings Report

**Run:** `pilot` · 2 simulated days · 8 adversarial customer personas + 1 admin + 1 auditor (all Opus) · 21 agents, **0 errors** · ~2.8M tokens.
**Artifacts:** `scripts/sim/runs/pilot/` (`findings.jsonl`, `day-1.md`, `day-2.md`, `events.jsonl`, `inbox.jsonl`).
**Method:** each persona acted only via the real store API against a seeded `pixelslot_sim` DB; the auditor re-executed every suspected finding's repro against the live backend and re-checked money invariants before confirming.

## Core integrity — PASS (both days)

- **Money:** every customer's credit ledger sums _exactly_ to their store balance; no balance ever went negative; pack debits are deterministic **by pack, never by the card pulled** (honest paid exactly 50 for an elite pack that yielded a _mythical_; high-roller paid exactly 5000 for a pack that yielded _commons_).
- **Security:** the exploit-hunter's attacks **failed to break anything** — overspend races floored at 0, same-key top-ups never double-credited, cross-account vault/delivery/read was **IDOR-blocked**.

## Findings (11 total — 10 confirmed, 1 unverified)

Ranked by priority. Each is reproduced in `findings.jsonl` with the exact request/response.

### P1 — money & missing capability (fix before launch)

1. **money-integrity — shown-but-unhonored buyback quote.** Pack-open reveal stamps a firm, deadline-carrying instant-buyback quote, but selling back does not honor that quote. A customer is shown a price the store won't pay. → Honor the stamped quote until its deadline, or stop presenting it as firm.
2. **missing-capability — no delivery cancel/reship.** `DELETE` and `POST /cancel` on a customer's own still-"requested" delivery order both 404 (route unregistered) while `GET` returns 200. Worse: the buyback error tells the user to "cancel the delivery first" — an **impossible action / hard dead end**. → Add a customer cancel route (and reship path).
3. **missing-capability — support can't adjudicate a buyback price dispute.** No operator endpoint surfaces a pull's quote history, so the desk can't resolve a "price I can't collect" complaint. → Add an admin quote-history/adjustment endpoint.

### P2 — ux-friction, medium

4. **Idempotent-replay is invisible.** A same-key top-up replay returns `200` with `amount:25` and a **new gateway reference** while the balance doesn't move — no `replayed:true` flag. Indistinguishable from a second successful charge. → Return a `replayed` indicator.
5. **Buyback on an out-for-delivery card** 400s "…out for delivery and can no longer be sold" — correct state, but combined with (2) it's a dead end.

### P3 — ux-friction, low (message/validation quality)

6. **Keyless top-up returns developer jargon** in a user-facing 400 ("An Idempotency-Key header is required…").
7. **Daily-draw "nothing"** returns `{status:"drawn",prize:{kind:"nothing"}}` with no human-readable "you won nothing today, come back tomorrow" message — reads like a failure.
8. **`createAddress` accepts null `country_code` AND null `postal_code`** (200, no warning) — an undeliverable address is silently accepted.
9. **Double-submit of a delivery request** 400s "One or more cards are no longer available to deliver." — correct state, misleading message.
10. **Shared rate limiter mislabels** — `POST /store/rewards/claim` can be answered "Too many delivery…" because it shares the delivery-write limiter.

### Unverified (low)

11. **bug (suspected) — missing showcase-sell guard.** `buyback-pull.ts` guards only `status !== "vaulted"` with no explicit showcase check. Not reproduced under load; worth a code read.
    → **Code-read 2026-07-11: not a bug.** The public profile collection filters `showcased && status === 'vaulted'` (`store/profiles/[handle]/route.ts`), so a bought-back pull drops out of showcases automatically; selling a showcased card is legitimate and leaves nothing rendered stale. No guard needed.

## Harness caveat the auditor caught (already fixed)

`admin-client.getCustomerTransactions` called the paginated ledger route with no `limit`, so summing the first page mis-totaled any customer with >25 rows (high-roller: 4997 vs true 5008). **The product endpoint is correct** (paginates, returns `total`) — this was a sim-consumer bug. Fixed: the client now pages through all rows. Operator lesson for production tooling: never `sum(one page)`; page to `total` (or read the store wallet).

## Recommended fix order

P1 (1–3) → P2 (4–5) → P3 (6–10). (11) is a quick code read. Money-path and new-route changes (1, 2, 3) should ship with tests and a `/security-review`.
