# Live Leaderboard Targets Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, inline with one final fresh review.

**Goal:** Configure and track production Top N rank goals without changing an existing run.

**Architecture:** Extend the shared rank engine with explicit live eligibility, add a live target adapter and uncached production observations, and gate the existing claim worker. Store optional runtimes in live state JSON; add compact controls and progress to the existing admin panel.

**Tech Stack:** TypeScript, Medusa, PostgreSQL, React, Medusa UI, Jest, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-live-leaderboard-targets.md`

## Global Constraints

- No dependencies or schema migrations.
- Do not start paid activity, check combined balances, or restart scheduled monitoring during delivery.
- Existing saved configurations remain compatible and unchanged.
- Existing Humanized timing and settlement workflows remain authoritative.

## Review Focus

- Missing/stale or wrong-customer observations never authorize a draw.
- A final settled draw still receives rank confirmation before the goal ends.
- Weekly rollover never turns old evidence into a new-week success.
- Rank waits must not block another eligible account or accelerate Humanized timing.
- Live mode must remain rejected by sandbox configuration validation.

### Task 1: Live rank decisions and worker integration

**Files:** automation-types.ts, automation-rank.ts, automation-live-types.ts, automation-live.ts, automation-live-store.ts; new automation-live-rank.ts and automation-live-leaderboard.ts; PacksModuleService.leaderboardTop.

**Interfaces:** `LiveRankTarget {customerId, period, targetRank}`; `refreshLiveRankGoals(state, observations, now)` updates persisted runtimes; `observeLiveRanks(packs, targets, clock)` returns fresh own-score/visible-board observations. `claimLiveCycle` remains the only paid-cycle claim.

- [x] Write failing Jest tests for validation, conflicts, stale/wrong-customer data, two confirmations, final-cycle confirmation, pending timeout, weekly rollover, fair scheduling and Humanized waits.
- [x] Run targeted Jest suite and observe failures.
- [x] Implement live adapter, production aggregates, transactional worker gating and persistence without changing ordinary runs.
- [x] Run targeted suites and type/lint checks. Commit backend changes.

### Task 2: Admin goals and progress

**Files:** new live-rank-settings.tsx; live-panel.tsx, live-account-activity.ts and corresponding tests.

**Interfaces:** settings consume LiveConfig/LiveSnapshot and an onChange callback; activity renders terminal goal state before ordinary cycle completion.

- [x] Write failing activity tests for secured, limited, stale and non-target accounts.
- [x] Implement explicit Add goal / remove controls with shared validation, active-run locking and per-account evidence.
- [x] Run admin tests, pinned TypeScript, Vite build and browser fixture checks. Commit UI.

### Task 3: Review and delivery

- [x] Fresh review of complete branch; fix findings with regression tests.
- [ ] Run required CI including disposable database HTTP settlement/feed tests; create and attach PR.
- [ ] Merge passing PR and verify production build/controls read-only. Confirm monitoring stays paused and current run settings unchanged.

## Execution ledger

Ruling: Live goals use reach-only semantics and existing cycle limits, avoiding additional funding/duration settings. Rank selection remains explicit; no account/rank assignment is inferred.

Validation: 137 targeted API tests and 431 admin tests passed; API/admin TypeScript and changed-admin lint passed; disposable database HTTP draw/buyback/reconciliation/feed plus limit/reached-goal paths passed. Browser fixture conflict, save, active locks and mobile checks passed. Reviewer found weekly-reset evidence and queue-display gaps; both fixed with RED/GREEN regression tests. Additional expiry test guards reset between observation and claim. Ruling: Commit backend and UI together because live shared types and consumers form one delivery unit.
