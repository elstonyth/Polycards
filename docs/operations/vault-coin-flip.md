# Vault coin flip

Design: [approved specification](../superpowers/specs/2026-10-28-vault-coin-flip-design.md).

## Behavior

Players choose Head (emblem) or Tail (wordmark) and 1–20 vaulted cards for one toss. Each card is quoted for 60 seconds (accept refuses if the bundle is now worth less, and honours the quote if it rose) at its displayed MYR market value: USD value × market multiplier × current strict FX, rounded to sen. There is no configured card-value or total-stake cap. A win retains every selected card and credits their total value. A loss marks every selected Pull `forfeited`, removes their showcase flags, and gives no credit. Forfeiture does not restock inventory. Another flip requires another quote and explicit confirmation.

The account must have topped up, completed deposit/external-funded playthrough, and pass existing disabled/frozen, phone and withdrawal-blocked group checks. A positive wallet balance is not required. Bonus and gift cards participate. Winnings are normal Credit with zero bonus and external-funded basis; they do not create playthrough, XP, VIP or referral basis. Existing Pull funding tags remain intact, so a later buyback retains its usual playthrough treatment.

The effective player group and pack odds-set selector are shared with packs. Coin-specific actual rates inherit 3 → 2 → 1 only when null; explicit zero stays zero. Published odds are configured independently and are the only odds sent to customer pages. Admin history retains the actual rate, published rate, group, valuation, config revision, draw, funding and credit reference.

Desk bots never read the actual rates, draws or a group's odds set (owner decision, 2026-10-30). `/reports/admin/read` blocks `/admin/coin-flips`, and `/reports/admin/sql` refuses `coin_flip_config`, `coin_flip_round` and those field names. Both hide the same fields in the rows that stay open (audit before/after, group metadata). Flip outcomes and the published chance stay readable on CF ledger rows. The admin assistant's screen and SQL tools share these checks.

## Deployment and eligibility maintenance

No production migration, enablement or deployment was performed during implementation.

1. Back up the database; deploy backend migrations `Migration20261103100000` to `Migration20261103100400` and backend code before frontend/admin consumers. `100000` seeds a disabled, unconfigured singleton and adds its checks on live money tables NOT VALID. `100100` removes the stake-cap requirement and widens stake storage to numeric sen. `100200` adds tickets, and rewrites the ticket reason CHECK after Lucky Draw's `Migration20261030100000`, so it must keep `pack_spin`. `100300` builds the one-win-per-round index, which blocks credit writes for that scan. `100400` validates the checks. The migrator runs all pending migrations in one transaction, so a deploy that applies these together holds the lock on `pull`, `credit_transaction`, `ledger_entry` and `admin_action_audit` through those scans: reads and writes on them stalled for 165 ms at most on a copy of production data on 2026-11-03. A lock wait over 5 seconds fails the deploy; retry it. Do not enable until actual Set 1 and published odds are configured and reviewed. All five sort after master's `Migration20261030120000`, and the audit CHECK here already keeps `goods_receive_note`; re-check both when merging newer migrations.
2. Existing Pulls have no workflow-finality stamp and fail closed for coin flipping. New pack/gift HTTP opens stamp eligibility only after workflow state is `DONE` with no errors. Atomic rewards stamp inside their creation transaction. A missed post-commit stamp leaves a valid card temporarily ineligible; it does not invalidate the purchase.
3. For legacy cards or missed-stamp repair: pause coin flips, stop pack-opening ingress, drain active opens and stop workers that could retry or compensate them. Resolve failed/pending workflows. Merely waiting for old cards, reading a debit, or seeing a reveal does not prove finality.
4. Run `medusa exec ./src/scripts/backfill-coin-flip-eligibility.ts` from the API package for a dry run. It changes nothing. After the maintenance conditions above are verified, set `COIN_FLIP_INGRESS_DRAINED=1` and run the same script with the word `apply` after it (`medusa exec` refuses unknown flags, so `--apply` cannot reach it). It also stamps cards in delivery, which return to the Vault if their order is cancelled. The service also checks that coin flips remain paused and serializes per customer. Unset the assertion afterward. On a copy of production data from 2026-11-02, the migrations took 23 s and the apply took 54 s for 8,482 cards, so plan a pause of about a minute in pack opens.
5. Resume ingress/workers. Configure the audited admin **Coin flip** page, test with controlled accounts, then explicitly enable. Pause invalidates pending quotes while completed receipts remain readable.

The database migration refuses rollback while coin-flip history exists. Preserve financial records and use a forward repair; do not delete rounds or payout rows to force rollback. Customer erasure follows the existing retained financial-history policy.

## Settlement and support

Acceptance acquires the same customer credit lock used by buyback and delivery, locks selected cards in sorted order, rechecks account/every card/version/config/group/expiry, and writes all ownership changes, one Credit, one CF ledger and one receipt in one transaction. A stale or unavailable card rejects the entire bundle. Randomness uses one server CSPRNG draw, independently of the chosen face. Repeating acceptance of a completed round returns its original receipt without another draw or credit. The existing JSON snapshot stores the locked choice and per-card valuations; legacy single-card receipts default to Head. Mixed funding bundles appear as `mixed` in admin history, with individual sources preserved.

The storefront stores only a customer-scoped opaque pending round ID and its receipt URL. A lost response is unknown, never a loss. Recovery reads that round; retry uses the same ID. Missing receipts are cleared only on a definitive not-found response. History includes both wins and losses. Wallet refresh failure does not turn a settled receipt into a failed flip.

Admin **History & forfeited cards** filters by outcome, customer, funding source and MYT dates. Credit paid and forfeited valuation are separate totals. Economy reports subtract `coinFlipPayouts`; CF ledger entries carry wallet/vault deltas. No reroll, result edit, or automatic restock action exists.

## Coin presentation

Coin B uses the official emblem on Head and the Polycards wordmark without the emblem on Tail, including static fallbacks. Brushed black faces, shallow relief, machined bevels, fine edge reeding, studio reflections and contact shadows are rendered in a lazy-loaded Three.js scene. Materials follow the [Three.js physical-material API](https://threejs.org/docs/pages/MeshPhysicalMaterial.html); face maps use [CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html). `scripts/generate-coin-motion.mjs` runs Rapier at asset time and checks ten naturally settled traces: five strengths for each result. Runtime selects the face matching the server receipt; gesture strength affects presentation only. The browser never decides money or ownership. Drag/flick, tap and keyboard all use the same acceptance path. Reduced motion, unavailable WebGL, context loss and Skip animation reveal the same receipt.

The Games sheet and Vault selection action both open the coin page. The searchable Vault modal supports multiple selection; selected slabs remain beside the coin through settlement. Head/Tail tiles and small face labels identify the call, which locks with the quote. Wins lift the cards and reveal credit; losses lower and desaturate them. Camera projection tests cover every trace and drag offset so landings remain in frame.

The Head/Tail selector and static fallbacks use transparent renders of the actual scene (`public/coin-flip/coin-b-head.png` and `coin-b-tail.png`), rather than a separate CSS illustration. Regenerate both images when changing the model, face artwork or lighting. They use the scene's resting pose with a tighter camera crop, following [Three.js canvas capture guidance](https://threejs.org/manual/pages/tips.html).

On PC, after confirming the card, hold the left mouse button on the coin, drag upward and release. The full upward drag distance retains throw strength even when the player pauses before release; touch still uses recent flick velocity. Clicks, downward/mostly sideways drags, cancellation and lost capture do not toss. Mouse capture keeps release events attached outside the coin ([Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)).

Physics sources: [Rapier rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/), [Three.js documentation](https://threejs.org/docs/).
Viewport behavior follows [scrollIntoView](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView) and [focus with preventScroll](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus): show the coin before launch and retain keyboard focus without moving the landing afterward.

## Verification

Original implementation checks on 2026-10-28 in the retained `codex/vault-coin-flip` worktree (before the multi-card extension):

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

### Head/Tail, multi-card and odds follow-up

- API source units: 272 suites, 4,556 passed; 2 suites / 9 tests skipped. Coin PostgreSQL integration: 38 passed. Coin HTTP integration: 1 comprehensive scenario passed. Focused storefront flow, receipt boundary and motion tests: 19 passed. API/storefront/admin type checks and storefront/admin production builds passed.
- The odds sweep checks all 101 integer percentages from 100% to 0%, for both chosen faces. It executes 400 real PostgreSQL settlements with controlled draws immediately either side of each threshold (only the possible outcome at endpoints). It verifies the actual setting, correct landing, unchanged published rate, payout amounts and credit count. This is deterministic boundary coverage, not a statistical estimate of random frequencies.
- Bundle checks cover mixed funding, duplicate and overlapping selections, stale cards, retry idempotency and transaction rollback on injected write failures. Motion checks cover five strengths per face, camera bounds, quaternion continuity and stable correct landings.
- The local preview is a disposable in-memory simulation. Browser checks and actual PostgreSQL settlement tests are separate. The standalone QA fixtures have been updated for the new contract; their older full automation run is not counted as a rerun of this extension.
- Browser follow-up verified Head and Tail wins, both opposite-face losses, multi-card retention/forfeiture, desktop drag and button activation, narrow-screen picker and receipt, and admin 100%/0% saves. No browser errors or warnings remained after replacing the removed Three.js shadow constant. Starting a toss brings the coin into view; result focus preserves the landing position rather than scrolling the coin away.

### Removal of the stake-value cap

The admin setting, public settings field, picker restrictions and backend cap checks have been removed. The legacy database column is retained unused for compatibility; the forward migration clears it and invalidates pending quotes. Existing receipts are preserved and backfilled with the normal Medusa numeric representation. Money still requires positive, finite, exact sen within JavaScript's safe integer range.

Verification: 125 focused API unit tests, 40 PostgreSQL integration tests, the coin HTTP scenario, 19 storefront tests and 6 admin tests passed. RM60 million bundles were tested for both win and loss with wallet and card-state assertions, even when a stale legacy cap was present. Storefront/admin production builds and API/admin type checks passed.

### Mobile card visibility

On phones, a horizontal card strip sits directly below the shorter coin stage, showing the selected cards, total value and confirmed call throughout the toss. Confirmation and launch scroll this combined view below the fixed header. The result keeps the committed card snapshot visible, including forfeited cards, with a compact outcome and next actions. Desktop retains the detailed sidebar.

Verification: 15 focused flow/motion tests, lint, formatting and the storefront production build passed. Browser checks at rendered widths of 307px and 381px covered tap and mouse-drag launches, win/loss results, three-card selection and horizontal card scrolling without page overflow. The 1168px desktop layout and Games navigation remained intact. No browser errors or warnings were captured. Physical phone touch/GPU checks remain outstanding.

### Customer history

`GET /store/coin-flips` takes an optional `status=won|lost`; anything else reads both settled statuses, so a quote can never be listed. Every response also carries `totals: { head, tail }`: how all of that customer's settled flips landed, whatever the filter. The payout and forfeit sums in `coinFlipTotals` stay admin-only.

### Tickets in a flip

`POST /store/coin-flips/quotes` also takes `tickets`: 1 to 10,000 Lucky Draw tickets, alone (`{ tickets, chosen_side }`) or beside cards (`{ pull_ids, tickets, chosen_side }`). One toss decides the whole stake. It uses the same accept route, odds sets, published chance, eligibility checks and 60-second quote.

- **Settlement:** a win adds the staked number of tickets and a loss removes them, as one `lucky_draw_ticket` row (`reason = coin_flip`, `ref` = round id). Tickets not staked are untouched. Cards in the same flip settle as usual, in the same transaction, so a refusal changes neither.
- **Money:** tickets move none. They add no `credit_transaction` and nothing to the `CF` ledger entry; a flip with only tickets has neither, and has `stake_cents = 0`, so payout and forfeit totals only ever count cards. The win and loss counts include every flip. Admin's funding-source filter has a `tickets` option, which finds flips with only tickets.
- **Balance:** a quote holds nothing. Accept takes the credit lock then the `tickets:` lock and checks the balance again, because a Lucky Draw entry can spend tickets during the quote.
- **Schema:** `Migration20261103100200` adds `ticket_stake`, makes `pull_id` nullable, and adds `coin_flip_round_stake_kind_check` (cards, tickets or both, never neither). Only a win with cards carries a credit transaction.

Flipping tickets can grow a customer's ticket count. Each flip is capped at 10,000 so a win cannot overflow the Lucky Draw's `total_tickets`, but odds above 50% would mint tickets over time.
