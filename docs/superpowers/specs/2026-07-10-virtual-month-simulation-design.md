# Virtual Month Simulation — Design

**Date:** 2026-07-10
**Status:** Awaiting user review
**Goal:** Discover, before production, every gap in PixelSlot's customer-service and
operations surface by running a simulated month of store activity with adversarial
LLM customers and a live admin operator.

---

## 1. Purpose and the honest gate

The user's stated intent — *"everything must pass because I want production ASAP"* —
cannot be taken literally: a simulation designed to pass discovers nothing. The
resolution agreed in brainstorming:

> **Everything passing is the EXIT criterion, not the design goal.**

The simulation is adversarial. It hunts for failures, we fix them, and we rerun until
a fresh month produces no new blocking findings. That clean month is the production
go signal.

Because the actors are improvising LLM agents (approach C), the gate cannot be
"the same script goes green." It is instead:

**GATE:** A fresh adversarial month, run against the fixed codebase by agents with no
memory of prior runs, produces:

1. Zero new **confirmed** findings of severity `critical` or `high` in categories
   `bug` or `missing-capability`, **and**
2. Every prior finding verified fixed — the auditor replays each recorded repro and
   confirms the system now behaves correctly.

`ux-friction` and `policy-question` findings never block the gate. `unverified`
findings never block the gate.

This is a pen-test-shaped gate: a clean report, not a green assertion.

---

## 2. The world

**Backend:** the real Medusa API, built (not `medusa develop` — the watcher is flaky on
this machine), served against a dedicated `pixelslot_sim` Postgres database inside the
existing `pokenic-postgres` container, plus a dedicated Redis DB index.

**Environment:** `ALLOW_MOCK_TOPUP=true` is **required**. Verified in
`workflows/steps/topup-credits.ts`: the mock gateway fails closed without it.

**Seed (day 0):** packs, cards, odds, FX rates, rewards settings, avatar frames, one
admin user, one publishable key. **No customer accounts** — agents register themselves
through the real auth flow on their first active day, so registration is genuinely
exercised.

**Funding:** verified — `POST /store/credits/topup` runs through `mockCharge`, needs an
`Idempotency-Key` header, and declines any amount ending in `.13`. Agents can fund
themselves without a payment provider, and the `.13` decline gives the month a real
declined-payment path for free.

**Time:** each simulated day, after all actors have finished, a time-shift script moves
the relevant DB timestamps back 24 hours and flushes the sim Redis DB, so daily draws,
VIP accrual, and commission timing genuinely fire ~30 times. Agents re-authenticate
each day; no token survives a shift. The spec's implementation plan will enumerate the
exact timestamp columns shifted.

**Rate limits are part of the world, not a bug.** The API rate-limits writes per actor.
A `429` is only a finding if it blocks a legitimate customer from normal use.

---

## 3. The cast

All agents are **Opus** subagents.

### Customers (8 personas, one account each)

| Persona | Charter |
|---|---|
| Honest customer | A normal month. The control — if *they* struggle, that's the loudest finding. |
| Refund-seeker | Disputes, demands, escalation, social-engineering the rules. |
| Exploit-hunter | Double-spend, races, negative balances, replay, **and authorization probing** (IDOR on another customer's vault / pull / delivery IDs). |
| Confused newbie | Does everything wrong innocently. Finds UX cliffs honest users fall off. |
| High roller | Large balances, batch opens, VIP ladder edges, big buybacks. |
| Referral schemer | Self-referral, multi-account, commission farming, reversal edge-cases. |
| Impatient shipper | Delivery edge-cases: address change mid-shipment, cancel-after-ship, reship. |
| Buyback haggler | Price disputes, FX timing, buyback of already-delivered or showcased cards. |

Each has its own account, so chaos is attributable and agents don't corrupt each other.

### Admin (1)

Works the queue each day: refunds, credit adjustments, delivery management, freezes,
commission reversals — **using only real admin API endpoints**. Its binding rule:

> No workarounds. No direct DB edits. No pretending. If the API cannot do what the
> situation requires, file a `missing-capability` finding and tell the customer no.

The admin therefore discovers gaps by *trying to deliver* what customers want. It also
files `ux-friction` (adjudication data exists but is awkward or incomplete) and
`policy-question` findings (the endpoints permit an action but nothing defines whether
it's correct). The admin does not go bug-hunting — hostile and defender roles stay
separate. Bugs it stumbles into go to the auditor like anyone else's.

### Auditor (1)

Acts on nothing. Each day it:

- Checks invariants: credit conservation, no negative balances, ledger ↔ balance
  agreement, audit-trail completeness, every customer request eventually resolved or
  gap-logged. **Pack pulls are random, so the auditor asserts invariants, never exact
  outcomes** — "the balance fell by exactly the pack price" is checkable; "she pulled a
  Charizard" is not.
- **Verifies findings by re-executing their repro.** A claim is not a finding until the
  auditor reproduces it. Unreproducible claims are filed `unverified` and never block
  the gate. This is the defense against agents hallucinating events they never caused.
- Dedupes and records into the findings ledger.
- Classifies infrastructure errors (`ECONNREFUSED`, Knex pool timeouts) as **not
  findings** — otherwise the ledger fills with noise shaped like product bugs.

### The customer↔admin channel

PixelSlot has no support-ticket system. This is **pre-logged as finding #0**. To let the
month proceed, the sim uses a shared `inbox.jsonl` as a stand-in channel. Whether to
build real ticketing is one of the decisions escalated to the user (§8).

---

## 4. Orchestration and memory

**Orchestrator:** a Workflow script running a deterministic day loop:

```
for day in 1..30:
  health-check :9000/health   → fail loudly, never produce garbage findings
  spawn active customer agents (concurrency capped at 4)
  spawn admin agent           → works the inbox
  spawn auditor agent         → invariants, verification, ledger
  time-shift DB + flush Redis
```

Progress is watchable via `/workflows`; the run is resumable (`resumeFromRunId`) so a
crash on day 17 resumes at day 17.

**Memory:** no agent can hold a month in one context window, so agents are **re-spawned
fresh each day with a diary**. Each customer owns `diary/<persona>.md` — balance, open
requests, grudges, "the admin promised me X yesterday." The agent reads its diary, acts
via HTTP (its own auth token), and appends today's entry. The admin keeps a case log;
the auditor keeps the ledger. This is what keeps personas coherent: the refund-seeker
remembers being refused on day 4 and escalates on day 5.

**Concurrency is a feature.** Real stores have simultaneous customers; running several
agents at once is how races surface (double-spend on one balance, concurrent buyback).
The cap of 4 is a concession to the local Knex pool, not a design preference.

---

## 4b. The live viewer

The user must be able to **watch the world live** — customers walking, playing slots,
complaining; the admin working a queue.

**The seam that makes this cheap:** agents never describe motion. They emit *semantic*
events to `events.jsonl` — `arrived`, `played_pack`, `pull_result`, `complained`,
`admin_picked_up`, `admin_resolved`, `finding`. The **viewer owns all choreography**: it
decides that "refund-seeker complained" means the sprite walks from slot 3 to the admin
desk. Agents' jobs are unchanged; every pixel of presentation lives in one file whose
correctness nothing depends on.

**Transport:** `scripts/sim/viewer.mjs` — a small **zero-dependency** Node server
(`node:http` + `node:fs`) serving one static page plus an SSE endpoint that tails
`events.jsonl` as agents append. `localhost:4500`. Agents append with `O_APPEND` line
writes, atomic enough for concurrent sprites.
`ponytail: single-file tail; upgrade to a real bus only if agents outgrow one process.`

**Strictly live** (user's choice): no scrub/rewind controls are built. The event log
still persists on disk as a byproduct, so a crash does not lose the record and replay
remains a small later addition rather than a rebuild.

**The floor:** a `<canvas>` top-down pixel room drawn with rects — no art assets, no CDN
(matching this repo's self-contained convention). Stations: entrance, slot machines,
vault, admin desk. Sprites tween between them. Playing a slot spins reels; the result
flashes in the card's rarity color. An angry customer gets a bubble and marches to the
desk.

**The diagnostic moment:** the admin sprite has a visible queue. **When that queue grows
and stops draining, you are watching a customer-service gap happen.** That is what makes
this more than decoration.

**The sidebar:** day counter, each persona's balance and current action, admin queue
depth, and a severity-colored findings feed as the auditor confirms them.

The viewer finds no bugs by itself. Its value is that a human spots in ten seconds — a
customer stuck in a corner, a queue that never drains — what would take an hour to find
in a JSONL file. It is capped at two files and zero dependencies to stay proportionate.

---

## 5. Findings ledger

`findings.jsonl`, one structured record per gap:

```json
{
  "id": "F-014",
  "day": 9,
  "reporter": "admin | <persona> | auditor",
  "category": "bug | missing-capability | ux-friction | policy-question",
  "severity": "critical | high | medium | low",
  "status": "confirmed | unverified | fixed",
  "summary": "...",
  "repro": ["POST /store/... → 200", "GET /store/... → balance unchanged"],
  "endpoints": ["/store/credits/topup"]
}
```

Every finding must cite a real request/response pair captured in the run transcript.

### Severity rubric

| Severity | Meaning |
|---|---|
| `critical` | Money lost, duplicated, or created. Authorization breach. Data loss. |
| `high` | A customer or admin request cannot be completed at all. |
| `medium` | Completable, but behavior is wrong, silent, or unaudited. |
| `low` | Friction, confusion, missing affordance. |

---

## 6. Fix phase

Between months, findings are triaged by category:

- **`bug` (confirmed)** → fixed. Auth-touching fixes additionally get `/security-review`
  per repo rules.
- **`missing-capability`** → *build minimal, flag big*. Small gaps (refund-as-credit-
  adjustment with audit trail, delivery cancellation, reship) get a minimal real
  implementation. Anything subsystem-sized (full helpdesk/ticketing) is **proposed to
  the user before building** — this is what keeps "production ASAP" honest.
- **`policy-question`** → the user answers. The answer is encoded in code or in the
  admin playbook.
- **`ux-friction`** → logged, non-blocking.

**Showstopper rule:** if the auditor finds a defect that invalidates all subsequent days
(e.g. every balance is corrupt on day 9), it declares a **showstopper**: the run pauses,
that one bug is hotfixed, and the workflow resumes from that day. Everything else waits
for the normal fix phase.

---

## 7. Cost, scale, and failure handling

**Pilot first.** A 2-day / 2-customer pilot validates auth, inbox, diaries, time-shift,
findings, and health-checks before committing to a full month.

**Activity schedules** keep the month realistic and bound cost: the honest customer and
admin appear near-daily; the newbie shows up ~15 of 30 days; the exploit-hunter works in
concentrated attack bursts. Expect roughly 150–200 Opus agent-days, not 300.

**Sim-level failure handling:**

- An agent dying mid-day does not kill the month. The auditor records "customer X was
  absent day N" and the day closes.
- Every run reseeds `pixelslot_sim` from scratch; runs never contaminate each other.
- Local-stack hazards are known and mitigated: Knex `pool is full` (concurrency cap 4),
  runaway node processes (swept between days), flaky watcher (run built, not `dev`).

**Artifacts:** everything under `scripts/sim/runs/<run-id>/` — diaries, `inbox.jsonl`,
`findings.jsonl`, per-day one-paragraph summaries so the month reads as a story, and the
raw HTTP transcript that findings cite.

---

## 8. Known blind spots and escalated questions

Stated explicitly rather than discovered late.

**Blind spot — the storefront is never exercised.** The simulation is API-level by
choice. A gap like "the refund endpoint exists but no UI reaches it" is invisible to it.
**Mitigation, folded into this spec as a required post-gate step:** once the gate is
clean, replay every confirmed-fixed customer flow and every new admin capability through
the real storefront and admin dashboard (Playwright, per repo convention) to confirm a
human can actually perform them. A capability with no UI is not shippable.

**Pre-existing production blocker — there is no real payment gateway.** `mockCharge` is
a seam. The simulation tests the seam, not a gateway. Independent of the sim's outcome,
production requires a real PSP. This has a direct consequence for refunds:

**Escalated policy questions (the user must answer; code cannot):**

1. **What is a refund?** With no PSP, "refund" can only mean a credit adjustment.
   Is credit-back acceptable at launch, or does launch require money-back?
2. **Refund on an opened pack.** The endpoints permit clawing back credits, but nothing
   defines whether the pulled card leaves the customer's vault. What is the rule?
3. **Support channel.** Is `inbox.jsonl`'s real-world counterpart email, or does launch
   need a ticketing system? (Finding #0.)
4. **Chargebacks.** With no PSP there is no chargeback webhook. The sim injects them as
   admin-side events ("the provider says reverse this"). Is that the intended production
   shape?

---

## 9. Success criteria

The simulation is done when:

1. A fresh month yields zero new confirmed `critical`/`high` findings in `bug` or
   `missing-capability`, and
2. All prior findings are verified fixed by repro replay, and
3. The post-gate UI replay (§8) confirms each fixed flow is reachable by a human, and
4. The escalated policy questions (§8) have user answers, encoded.

The final `findings.jsonl` — everything found, everything fixed, everything consciously
deferred — is the evidence document for the production decision.

---

## 10. Decomposition

This spec covers the **harness and the run protocol**. The fix work cannot be specified
in advance — it is discovered by the run. Therefore the work splits into phases, each
with its own implementation plan:

| Phase | Scope | Planned when |
|---|---|---|
| 1 | Harness: seed, time-shift, agent clients, inbox, ledger, event stream, **live viewer (§4b)**, workflow day loop. Validated by the 2-day pilot. | Now — the next plan. |
| 2 | Month 1: the adversarial run. Produces `findings.jsonl`. | No plan needed; it is execution of phase 1's artifact. |
| 3 | Fix batch(es), triaged per §6. Subsystem-sized gaps escalate to the user first. | After month 1, from the ledger. |
| 4 | Gate: fresh month + repro replay + post-gate UI replay (§8). | After phase 3. |

Only phase 1 is specified here. Phases 3 and 4 get their own plans once the findings
exist, because writing them now would be inventing bugs we have not yet found.
