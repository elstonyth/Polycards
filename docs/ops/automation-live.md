# Live Automation

Admin → Players → Automation opens the **Live workspace**. Its `/admin/automation/live` API uses production customer credit, the normal paid pack workflow and the normal buyback workflow. The separate Test workspace stays isolated.

Select existing accounts from the Accounts tab, an available paid pack, interval and cycles per account. There is no total spend cap. Save settings does not start a run. **Start live run** explicitly starts paid draws; each card is sold back and total and bonus balances are reconciled. Normal ledger, odds, bonus playthrough, leaderboard, VIP and reward rules apply.

The cloud worker executes one cycle at a time. Limits: 1–80 selected accounts and 1–10 cycles per account. Each account must have enough credit for its next draw; buyback proceeds can fund later cycles. The pack price at start caps each subsequent charge to prevent a price increase during a run. Pause and Stop let an already claimed cycle finish settlement. No missed intervals are queued. Deploying or opening the page never starts a run. Older clients may still send `maxSpendMyr`; the API discards it when saving settings.

Every successful paid draw writes a normal `source = 'pack'` or bonus-funded `source = 'bonus'` pull. Both the storefront home and pack-specific recent-pulls feeds include it even after buyback, with drought and hit-gap counters using the same sources. Free, gift and reward pulls remain private; disabled accounts remain hidden under the existing public-feed policy. The feed shows the latest 12 pulls and refreshes every 10 seconds, with a five-second cache at each API hop. Public rows contain the card, pack, pull ID and public player profile, never customer IDs or email addresses.

Any workflow failure or balance mismatch stops the run. Results include the customer, stable open/cycle UUID, returned pull ID, charged amount, sale amount and balance differences. Concurrent customer activity or rewards can cause a verification mismatch; review the ledger before starting another run.

An interrupted cycle remains claimed. After five minutes it is marked failed and further starts stay blocked. This deliberately needs operator reconciliation rather than an automatic money retry. Use the pending cycle UUID to inspect `pull.open_id` and `credit_transaction.source_transaction_id`; inspect buyback credit by `credit_transaction.pull_id`. Confirm the original worker is no longer executing, reconcile any partial workflow or unsold card, and preserve the incident details before repairing the pending workspace state. Do not clear a pending marker or restart a paid draw without that review.

Deployment adds `automation_live` without modifying existing customer or sandbox records. The scheduled `automation-live` job runs every two seconds on the worker. Existing `automation:read` / `automation:update` policies and the admin write limiter protect the API.

Deploy the spend-cap removal while the workspace is idle, with no pending cycle. Keep its existing saved settings until every API and worker instance is on the new revision, then save the uncapped configuration. An old worker cannot process the new configuration without `maxSpendMyr` during a mixed-version rollout.

Verification: unit coverage for uncapped spend, per-account cycles, concurrency claims, stop, interrupted cycles, bonus and total balance reconciliation, and price increases at the charge step; database-backed HTTP coverage performs three actual paid opens and buybacks in a disposable local database, verifies each ledger entry and both balances, checks every pull in the global and pack-specific public feeds after cache expiry, and proves saving/reading does not transact.
