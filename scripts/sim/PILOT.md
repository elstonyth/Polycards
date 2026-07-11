# scripts/sim/PILOT.md — 2-day pilot runbook

Prove the harness end-to-end before any 30-day run.

## Preconditions

- Docker containers up: `docker ps` shows pokenic-postgres, pokenic-redis.
- Backend env file present at `backend/packages/api/.env` (provision.mjs and
  start-backend.mjs self-read `DATABASE_URL`/`REDIS_URL` from it — no shell
  export needed; never print its values).

## Steps

1. `npm run sim:test` → all unit tests green.
2. `node scripts/sim/provision.mjs pilot` → recreates pixelslot_sim, seeds, writes
   runs/pilot/pk.txt, and provisions admin `sim-admin@pixelslot.local` /
   `SimAdmin2026!` (also written to runs/pilot/diary/admin.md — log in via
   POST /auth/user/emailpass to get the admin token).
3. Start the sim backend: `node scripts/sim/start-backend.mjs` (run in
   background). It self-reads the backend .env, swaps the DB to pixelslot_sim
   and Redis to index 9, binds :9100 (SIM.backendUrl — :9000 belongs to dev
   backends), and sets ALLOW_MOCK_TOPUP=true + REWARDS_REDEMPTION_ENABLED=true
   (the latter gates `POST /store/daily/draw` — see rewards-gate.ts — and is
   read at request time by the backend process, not by provisioning).
   Health: `curl -s localhost:9100/health` → ok.
4. Identity guard: `node scripts/sim/preflight.mjs pilot` → must print
   `preflight OK`. This proves the backend answering :9100 is the one step 2
   provisioned (this run's publishable key + sim-admin login), not a stray dev
   backend — a plain health check cannot tell them apart. The workflow re-runs
   this before day 1 and aborts if it fails.
5. Start the viewer: `node scripts/sim/viewer.mjs pilot` → open http://localhost:4500.
6. Run the loop via the Workflow tool: `Workflow({ scriptPath: 'scripts/sim/run-month.workflow.mjs', args: { runId: 'pilot', days: 2 } })`.
   Note: this launch is also the first moment `run-month.workflow.mjs` is known
   to parse — `node --check` cannot validate the Workflow dialect (`export
const meta` + top-level `return`).

## Pass criteria (the gate for Phase 1)

- [ ] Both customers registered + acted; events.jsonl has arrived/played_pack for each.
- [ ] A refund_request reached inbox.jsonl and the admin either resolved it or filed a `missing-capability` finding.
- [ ] Day 1 daily draw succeeded; after `shiftDay(1)`, Day 2 daily draw succeeded again (proves the text-day shift works). If Day 2 is blocked "already drew today", add the missing column to SIM.TIME_SHIFT_TARGETS and re-run.
- [ ] Auditor produced day-1.md and day-2.md and at least ran invariants.
- [ ] Viewer showed sprites moving and (if any) a finding in the feed.
- [ ] No infra errors misfiled as findings.
