# Vault coin flip

Implementation: `codex/vault-coin-flip`. Design: [approved specification](../superpowers/specs/2026-10-28-vault-coin-flip-design.md).

## Behavior

One vaulted card is quoted for 60 seconds at its displayed MYR market value: USD value × market multiplier × current strict FX, rounded to sen. A win retains the card and credits that exact value. A loss marks the Pull `forfeited`, removes its showcase flag, and gives no credit. Forfeiture does not restock inventory. Another flip requires another quote and explicit confirmation.

The account must have topped up, completed deposit/external-funded playthrough, and pass existing disabled/frozen, phone and withdrawal-blocked group checks. A positive wallet balance is not required. Bonus and gift cards participate. Winnings are normal Credit with zero bonus and external-funded basis; they do not create playthrough, XP, VIP or referral basis. Existing Pull funding tags remain intact, so a later buyback retains its usual playthrough treatment.

The effective player group and pack odds-set selector are shared with packs. Coin-specific actual rates inherit 3 → 2 → 1 only when null; explicit zero stays zero. Published odds are configured independently and are the only odds sent to customer pages. Admin history retains the actual rate, published rate, group, valuation, config revision, draw, funding and credit reference.

## Deployment and eligibility maintenance

No production migration, enablement or deployment was performed during implementation.

1. Back up the database; deploy backend migration `Migration20261028120000` and backend code before frontend/admin consumers. Migration seeds a disabled, unconfigured singleton. Do not enable until maximum card value, actual Set 1 and published odds are configured and reviewed.
2. Existing Pulls have no workflow-finality stamp and fail closed for coin flipping. New pack/gift HTTP opens stamp eligibility only after workflow state is `DONE` with no errors. Atomic rewards stamp inside their creation transaction. A missed post-commit stamp leaves a valid card temporarily ineligible; it does not invalidate the purchase.
3. For legacy cards or missed-stamp repair: pause coin flips, stop pack-opening ingress, drain active opens and stop workers that could retry or compensate them. Resolve failed/pending workflows. Merely waiting for old cards, reading a debit, or seeing a reveal does not prove finality.
4. Run `medusa exec ./src/scripts/backfill-coin-flip-eligibility.ts` from the API package for a dry run. It changes nothing. After the maintenance conditions above are verified, set `COIN_FLIP_INGRESS_DRAINED=1` and run the same script with `--apply`. The service also checks that coin flips remain paused and serializes per customer. Unset the assertion afterward.
5. Resume ingress/workers. Configure the audited admin **Coin flip** page, test with controlled accounts, then explicitly enable. Pause invalidates pending quotes while completed receipts remain readable.

The database migration refuses rollback while coin-flip history exists. Preserve financial records and use a forward repair; do not delete rounds or payout rows to force rollback. Customer erasure follows the existing retained financial-history policy.

## Settlement and support

Acceptance acquires the same customer credit lock used by buyback and delivery, rechecks account/card/version/config/group/expiry, and writes ownership, Credit, CF ledger and receipt in one transaction. Randomness uses the server CSPRNG. Repeating acceptance of a completed round returns its original receipt without another draw or credit.

The storefront stores only a customer-scoped opaque pending round ID and its receipt URL. A lost response is unknown, never a loss. Recovery reads that round; retry uses the same ID. Missing receipts are cleared only on a definitive not-found response. History includes both wins and losses. Wallet refresh failure does not turn a settled receipt into a failed flip.

Admin **History & forfeited cards** filters by outcome, customer, funding source and MYT dates. Credit paid and forfeited valuation are separate totals. Economy reports subtract `coinFlipPayouts`; CF ledger entries carry wallet/vault deltas. No reroll, result edit, or automatic restock action exists.

## Coin presentation

Coin B uses the official logo, brushed black faces, beveled metallic rims/reeding, lighting and contact shadows in a lazy-loaded Three.js scene. `scripts/generate-coin-motion.mjs` runs Rapier at asset time and checks ten naturally settled traces: five strengths for each result. Runtime selects the face matching the server receipt; gesture strength affects presentation only. The browser never decides money or ownership. Drag/flick, tap and keyboard all use the same acceptance path. Reduced motion, unavailable WebGL, context loss and Skip animation reveal the same receipt.

The Games sheet and single-card Vault action both open the coin page. The searchable Vault modal replaces the dropdown; the selected slab remains beside the coin through settlement. Wins lift the card and reveal credit; losses lower and desaturate it. Camera projection tests cover every trace and drag offset so landings remain in frame.

Physics sources: [Rapier rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/), [Three.js documentation](https://threejs.org/docs/).

## Verification

Verified on 2026-10-28 in the retained `codex/vault-coin-flip` worktree:

| Check | Result |
| --- | --- |
| Storefront unit/component tests | 161 files, 1,795 passed; final focused camera/focus tests also passed |
| API source unit tests | 272 suites, 4,453 passed after corrected Wallet-filter rerun; 2 existing suites / 9 tests skipped |
| Admin unit tests | 49 files, 531 passed |
| PostgreSQL coin-flip / Lucky Draw integration | 32 / 67 passed |
| Coin-flip, buyback, ledger, mixed delivery and reporting HTTP integration | 38 passed |
| Storefront, API and admin production builds | Passed |
| Changed storefront/admin lint and storefront formatting | Passed |
| Original storefront and admin browser QA | Passed before redesign, including mouse/touch flicks and axe |
| Redesigned storefront browser QA | Games/Lucky Draw/Coin Flip navigation, visual Vault modal at desktop and phone widths, focus restoration, tap loss, upward-flick win, both settled faces, card removal/retention and admin settings save verified in disposable preview |
| Original independent branch review | Findings fixed before latest-master integration |

- Backend database integration covers simultaneous acceptance, stale card versions, buyback/delivery/freeze races, compensation, funding basis, strict migration checks and injected write failures.
- HTTP integration covers authenticated customer/admin requests, stale settings revisions, private-field boundaries, payout replay, loss and history. Buyback regressions also run.
- Storefront tests cover one-card entry, cancel/arm without settlement, double press, uncertain response recovery, missing receipts, expiry and focus. Motion tests check bounds, quaternion continuity and both final faces.
- `node scripts/qa-coin-flip.mjs` runs a local production standalone UI against deterministic mock responses on ports 9000/4020; never point it at production. It checks actual mouse and mobile touch flicks, both outcomes, fresh selection, reload recovery, reduced-motion keyboard, WebGL loss, axe and mobile overflow. Screenshots/logs are under `.superpowers/sdd/2026-10-28-vault-coin-flip/qa/`. Real server settlement is tested separately.
- Admin input tests distinguish blank inheritance from zero and reject malformed/range/precision inputs. Backend enforces the same rules and audited optimistic revisions. `node scripts/qa-admin-coin-flip.mjs` checks the built admin on port 7030 with intercepted local responses, including draft persistence, stale revisions, funding filters, private receipts and axe.

On this Windows host, use the backend workspace's pinned TypeScript and Vite binaries for admin builds: `node ../../node_modules/typescript/bin/tsc -b` then `node ../../node_modules/vite/bin/vite.js build` from `backend/apps/admin`. For API unit tests after a build, append `--testMatch '**/src/**/__tests__/**/*.unit.spec.ts'` to exclude generated JavaScript test copies under `.medusa`.

Physical iOS/Android GPU and touch calibration still requires device QA before launch. Existing dependency audit/security advisories and admin bundle-size warnings are outside this feature’s dependency changes.
