# Live Automation

Admin → Players → Automation opens the **Live workspace**. Its `/admin/automation/live` API uses production customer credit, the normal paid pack workflow and the normal buyback workflow. The separate Test workspace stays isolated.

Select existing accounts from the Accounts tab, an available paid pack, interval, cycles per account and total spend limit. Save settings does not start a run. **Start live run** explicitly starts paid draws; each card is sold back and total and bonus balances are reconciled. Normal ledger, odds, bonus playthrough, leaderboard, VIP and reward rules apply.

The cloud worker executes one cycle at a time. Limits: 1–80 selected accounts, 1–10 cycles per account, RM8,000 maximum total spend. The pack price at start also caps each subsequent charge. Pause and Stop let an already claimed cycle finish settlement. No missed intervals are queued. Deploying or opening the page never starts a run.

Any workflow failure or balance mismatch stops the run. Results include the customer, stable open/cycle UUID, returned pull ID, charged amount, sale amount and balance differences. Concurrent customer activity or rewards can cause a verification mismatch; review the ledger before starting another run.

An interrupted cycle remains claimed. After five minutes it is marked failed and further starts stay blocked. This deliberately needs operator reconciliation rather than an automatic money retry. Use the pending cycle UUID to inspect `pull.open_id` and `credit_transaction.source_transaction_id`; inspect buyback credit by `credit_transaction.pull_id`. Confirm the original worker is no longer executing, reconcile any partial workflow or unsold card, and preserve the incident details before repairing the pending workspace state. Do not clear a pending marker or restart a paid draw without that review.

Deployment adds `automation_live` without modifying existing customer or sandbox records. The scheduled `automation-live` job runs every two seconds on the worker. Existing `automation:read` / `automation:update` policies and the admin write limiter protect the API.

Verification: unit coverage for limits, concurrency claims, stop, interrupted cycles, bonus and total balance reconciliation, and price increases at the charge step; database-backed HTTP coverage performs one actual paid open and buyback in a disposable local database, verifies its ledger and pull, and proves saving/reading does not transact.
