# Vault Coin Flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship the approved single-card coin flip with coin B, shared pack group selection, audited odds settings, atomic ownership/credit settlement, and accessible physical presentation.

**Architecture:** Keep Pull as the ownership authority and CreditTransaction as the only credit balance. Add coin-specific config/round models, transaction-managed service methods, explicit public DTOs, and small storefront/admin consumers. A lazy Three.js scene replays physics-derived landings; server outcomes never depend on client animation.

**Tech Stack:** Existing Next.js 16.4 / React 19 / Tailwind v4 storefront; Medusa 2.19 / PostgreSQL packs module; Mercur admin / React Query; Jest, Vitest, Playwright. Add Three.js for real 3D rendering and Rapier as an asset-generation dependency if replay generation permits.

**Spec:** ../specs/2026-10-28-vault-coin-flip-design.md — approved with all proposed defaults on 2026-10-28.

## Global Constraints

- One card per round; win keeps card plus 100% confirmed MYR Value, loss forfeits card and pays nothing.
- Bonus/gift cards included; retain original source/bonus_bp; only withdrawal-eligible accounts, including eligible zero-balance accounts.
- Existing player-group sets 1/2/3, DEFAULT precedence and null fallback; explicit 0% is not inheritance.
- Public sees published odds only; actual rates/set/group/RNG remain server/admin-only. Independent config and mismatch warning are approved.
- Quotes last 60 seconds, feature defaults disabled, no seeded production odds or maximum stake.
- Same-ID retry returns original result; quote versions prevent two stale confirmations of the same card.
- No automatic restock for forfeitures, no new pack/VIP/referral/challenge progress, no autoplay.
- Official logo, coin B, reduced motion, keyboard/tap alternatives, immediate result text, existing shell/Pill/SoundProvider.
- TypeScript strict, no any, named components, no inline UI styles, no unrelated checkout edits.

## Review Focus

- Same card quoted in two tabs: one version settles, the other must refresh (Tasks 2/4).
- Successful response lost after commit: retry must recover even if account later freezes or config pauses (Tasks 2/4).
- Bonus/gift win followed by ordinary buyback: no collision with unique buyback pull_id and original playthrough basis preserved (Task 2).
- Disabled or deleted account and concurrent buyback/delivery: shared locks and conditional claims prevent half-state (Task 2).
- Unknown enum/reason and public JSON leaks: all accounting/receipt consumers recognize new values, public serializers allowlist private snapshots (Tasks 1/3/6).

## Task 1: Rules, models, configuration and migration

**Files:** Create packs `coin-flip.ts`, `models/coin-flip-config.ts`, `models/coin-flip-round.ts`, `migrations/Migration20261028120000.ts`, `__tests__/coin-flip.unit.spec.ts`. Modify packs `service.ts`, `models/pull.ts`, `models/credit-transaction.ts`, `models/ledger-entry.ts`, `models/admin-action-audit.ts`, `ledger.ts`, migration snapshot as needed.

**Interfaces:** Export CoinFlipSettings (enabled, max_stake_amount, win_percent, win_percent_2, win_percent_3, published_win_percent, revision), CoinFlipPublicRound (id, status, expires_at, settled_at, stake_amount, win_amount, published_win_percent, card {pull_id,name,image,grader,grade}), configuration validation/percent-unit helpers, explicit public-round serializer. Amounts exposed as MYR; exact settlement math in sen. Config singleton ID `coin-flip`; round ID is acceptance key. service wrappers have explicit return types.

- [x] Write failing behavioral tests: 45.1234% maps to 451234 units; set 3 null inherits explicit set 2 zero; invalid/nonfinite/out-of-range precision refused; enabled config without value/rate refused; serialized public round has no actual/group/roll fields; 0/100% boundary draws.
- [x] Run backend Jest unit file; verify missing feature failure.
- [x] Implement pure rules/models and guarded additive migration; add forfeited + flip_version, coin_flip_win, CF ledger event, coin_flip_config audit type. Keep credit_transaction.pull_id null for flip wins.
- [x] Run rules tests and backend typecheck; confirm migration down refuses nonempty rounds/coin credit rather than deleting history.
- [x] Commit task.

## Task 2: Atomic quotes, settlement and racing ownership paths

**Files:** Create packs `coin-flip-operations.ts`, `__tests__/coin-flip.integration.spec.ts`; modify `service.ts`, `workflows/steps/buyback-pull.ts`, relevant delivery/account-state methods and their focused tests.

**Interfaces:** service `coinFlipSettings(context?)`, `saveCoinFlipSettings({settings,revision,adminId,reason},context?)`, `quoteCoinFlip({customerId,pullId},context?)`, `acceptCoinFlip({customerId,roundId},context?)`, `getCoinFlipRound({customerId,roundId},context?)`. Quote/accept/get return CoinFlipPublicRound. ORM list/count is used by history routes. Transaction methods take existing Medusa Context and shared Credit lock, then relevant row locks.

- [x] Write DB-backed tests with real service/isolated PostgreSQL: quote and win for zero-balance eligible account; gift/bonus normal-credit win; loss; same-key replay; stale version; later buyback after repeated win; rejection gates.
- [x] Run and observe failure against missing methods.
- [x] Implement snapshot quote and acceptance under one transaction, exact ownership/version/config/group checks, normal-credit/CF write, no outcome before commit. Add DB uniqueness and preserve terminal replay before fresh eligibility checks.
- [x] Make buyback Credit + Pull transition atomic with the same customer/lifecycle discipline, retaining its stock and bonus behavior. Resolve concrete lock orders for delivery/cancellation and account mutation; avoid widening into generic workflow infrastructure.
- [x] Exercise two-connection races and write-failure rollback; unchanged card/source/history on failed acceptance. Expired/paused quote cannot settle; completed receipts survive pause/freeze.
- [x] Run integration and affected unit tests, commit task.

## Task 3: HTTP/auth, histories and accounting

**Files:** Create store `coin-flips/quotes/route.ts`, `coin-flips/[id]/accept/route.ts`, `coin-flips/[id]/route.ts`, `coin-flips/route.ts`; admin `coin-flips/settings/route.ts`, `coin-flips/route.ts`; route unit tests. Modify `api/middlewares.ts`, rate-limit configuration, packs economy/ledger consumers, account retention, relevant DTO/label/export mappings.

**Interfaces:** Store quote POST {pull_id} -> {round}; accept POST -> {round}; owned GET -> {round}; history GET -> {rounds,count,limit,offset}. Admin settings GET -> settings; POST settings + expected_revision + reason -> settings. Admin history includes authorized private snapshot, funding source and result filters. Return stale/conflict as ordinary structured errors with no partial result.

- [x] Write route behavior tests: derives customer/admin from auth; foreign ID not found; body amount/odds/outcome cannot influence settlement; rate/permission protection; customer JSON has no private fields.
- [x] Write economy/receipt tests for CF loss, normal winning credit, separate payout/forfeited valuation, and unchanged VIP/referral basis.
- [x] Run tests red, implement routes and all enum/reason consumers; retain rounds/ledger on account erasure according to existing anonymous-history policy.
- [x] Run targeted API/accounting tests and backend typecheck; commit task.

## Task 4: Vault entry, confirmation, recovery and result UI

**Files:** Create `src/lib/coin-flip.ts` (Zod DTO/state utilities), `src/lib/actions/coin-flip.ts`, `src/app/(account)/vault/coin-flip/page.tsx`, `CoinFlipClient.tsx`, storefront tests. Modify VaultActionBar/VaultClient, transaction page/labels, account refresh integrations.

**Interfaces:** Actions quoteCoinFlip(pullId), acceptCoinFlip(id), getCoinFlipRound(id), getCoinFlipHistory(page) use existing Store port and explicit Zod DTOs. Client states idle/confirm/armed/submitting/result; pending ID belongs to authenticated session and is used only for recovery. Scene receives authoritative outcome and normalized gesture profile; it cannot call settlement itself.

- [x] Write tests for one-card entry, cancel without API acceptance, double press one ID, timeout then recovered win, stale quote re-confirmation, reduced-motion result, and no automatic new stake.
- [x] Observe red, implement native server route/client split after installed Next guides. Show exact card/value/terms; quote expiry disarms controls. Persist unresolved ID and recover before allowing new stake; never treat unknown network outcome as loss.
- [x] Wire wallet/Vault/history refresh and loss receipts; accessible dialog, keyboard/tap path, focused errors/remedies.
- [x] Run storefront tests/typecheck, commit task.

## Task 5: Black titanium physical coin

**Files:** Create `src/components/coin-flip/CoinScene.tsx`, `src/lib/coin-motion.ts`, motion tests, `scripts/generate-coin-motion.mjs`, compact public motion data/static fallbacks. Modify package manifest/lock and sound seam only where necessary.

**Interfaces:** CoinScene takes phase, won|null, reducedMotion, gesture callback, completion callback; callbacks have no financial authority. Motion profile stays bounded and selected trace always lands face matching won. Texture loading uses official logo; chosen concept is reference, not flattened scene.

- [x] Test gesture thresholds/cancel, trace start/end orientation, no unsupported/out-of-range sample, and both faces.
- [x] Add Three.js and asset-time Rapier; generate real collision-derived traces with a small assert-based self-check. Build satin dark metal, exposed silver rim/emblem, edge thickness, tabletop contact shadow, bounded drag, impact/wobble and mute-aware contact sound.
- [x] Keep libraries lazy-loaded; handle WebGL failure/context loss with static final face and immediate result text; skip animation supported.
- [x] Run motion checks/tests and build; inspect phone/desktop screenshots and keyboard/reduced-motion flows; commit task.

## Task 6: Admin settings, private history and operator visibility

**Files:** Create `backend/apps/admin/src/routes/coin-flips/page.tsx`, `lib/coin-flips.ts`, validation/format tests. Extend existing query/sidebar/export integration as required.

**Interfaces:** Consume Task 3 endpoints; settings edits use expected_revision and mandatory audit reason. Tabs for settings/history; show effective inherited values, explicit zero, actual/published mismatch, pause, maximum card value, immutable round detail and forfeited holdings.

- [x] Test rate inheritance and percent/amount form parsing (blank vs zero), disabled initial state, stale revision error, safe pagination/filter serialization.
- [x] Implement with existing client/React Query/Medusa UI/StickySaveBar/Pager patterns and route config. Do not add a reroll/change-result action.
- [x] Run admin tests/typecheck/build, commit task.

## Task 7: End-to-end verification, docs and final review

**Files:** Add `scripts/qa-coin-flip.mjs`, focused HTTP integration fixtures/tests; update CONTEXT.md, ADR 0010, DESIGN.md, plan/ledger.

- [x] Exercise owned/authenticated request chain and a production standalone browser build with deterministic test backend responses for win/loss/recovery; verify actual backend separately with DB tests.
- [x] Run full storefront suite, full backend unit tier, affected DB/HTTP integration, admin tests, all changed-package typechecks and production builds. Report baseline-only warnings/failures by name.
- [x] Check migration SQL on isolated DB, public data leak boundary, history/repeated-win/buyback behavior and mobile keyboard/motion fallback.
- [x] Fresh whole-branch review against approved spec; fix important findings with red-to-green tests. No live migration, production enablement, deployment or shared-branch merge is part of local implementation.
- [x] Commit docs/fixes, record evidence and retained worktree. Present working result and any measured limitations.

## Execution

User explicitly approved design and requested implementation. Proceed in this session using executing-plans and test-driven-development; no additional execution-method approval needed. Read-only reconnaissance and final independent review are permitted by repository agent instructions. Keep progress in this plan's .superpowers/sdd workspace.

## Completion evidence

Implemented on `codex/vault-coin-flip`; retained managed worktree at `C:/Users/PC/.codex/worktrees/vault-coin-flip/Polycards`. Storefront 1,512 tests, API source unit 2,913 tests (9 existing skips), admin 284 tests, PostgreSQL 26 tests, and HTTP 8 tests passed. All three production builds, changed-file lint, storefront formatting, desktop/mobile touch browser QA and independent review passed. See [rollout and verification guide](../../operations/vault-coin-flip.md). Production remains unmodified; device calibration and existing dependency advisories remain launch follow-ups.
