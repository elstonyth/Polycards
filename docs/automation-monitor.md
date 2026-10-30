# Automation: read-only account monitoring

Open `/dashboard/automation` under Players. This release links up to 80 existing
registered accounts and displays their current MYR balances and account status.
Weekly and all-time top-10 views reuse the public leaderboard calculation and
its 30-second cache. Refresh is manual; no polling, workers or scheduled jobs.

The page reads through the authenticated Polycards admin API. It needs no
BitBrowser, profile IDs, customer passwords or customer login sessions.

An administrator provisions the list with `POST /admin/automation/accounts`,
body `{ "emails": ["account@example.test"] }`. Every email must match an existing
registered customer. Duplicate, unknown, malformed and over-80 selections fail
without replacing the saved list. Only customer IDs and the importing admin ID
are saved in `automation_monitor`; account groups and financial records stay
unchanged. The saved list survives app restarts and deploys.

Reads require `automation:read`. Loading a list requires `automation:update`
and `customer:update`. The dashboard has no account mutation
controls. There are no run, pause, resume, stop, pull, sell or credit-grant routes
under Automation in this release.

Deployment uses the existing backend DigitalOcean app and its migration job.
The migration adds one independent table. Rolling back the application leaves
that unused table intact, with no change to customer or financial data.
