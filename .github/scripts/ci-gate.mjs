#!/usr/bin/env node
// Waits for master CI to pass on a commit before deploy.yml deploys it.
//
// Polls the `ci-ok` check run (ci.yml's aggregate job, posted by the GitHub
// Actions app) of the push-event CI run on SHA until it completes; a manual
// CI run's ci-ok never counts. Only `success` deploys. One case
// skips quietly instead of failing: master has moved on past SHA. App
// Platform builds the branch tip, so this run could never ship SHA anyway,
// and the newer push's Deploy run ships it from its live-commit diff once its
// own CI passes. (ci.yml cancels superseded master runs, and `ci-ok` then
// concludes failure, so a moved head is the signal, not the conclusion.)
// Anything else (failure, timed_out, skipped, no ci-ok within TIMEOUT_MIN, no
// CI run at all after NO_CI_GRACE_MIN, e.g. [skip ci]) fails the gate and
// nothing deploys.
//
//   node .github/scripts/ci-gate.mjs          CI: reads env, writes deploy=true|false
//   node .github/scripts/ci-gate.mjs --test   built-in self-check
//
// Env: GITHUB_TOKEN (checks: read, actions: read), GITHUB_REPOSITORY, SHA,
// optional TIMEOUT_MIN (default 60), NO_CI_GRACE_MIN (default 5), INTERVAL_S
// (default 30), GITHUB_API_URL.

import { appendFileSync } from 'node:fs';

const CHECK_NAME = 'ci-ok';
const GITHUB_ACTIONS_APP_ID = 15368; // ignore same-named checks from other apps

// run: the latest ci-ok check run on SHA, or null if none exists yet.
// head: the commit master points at now.
// ciRuns: how many push-event ci.yml runs exist for SHA (it matters only
// while there is no ci-ok yet). waitedMs: time since the gate started.
// Returns { state: 'wait' | 'deploy' | 'superseded' | 'fail', why }.
export function decide({ run, head, sha, ciRuns, waitedMs = 0, graceMs }) {
  if (head && head !== sha) {
    return {
      state: 'superseded',
      why: `master moved on to ${head.slice(0, 9)}; that push's Deploy run ships this commit once its CI passes`,
    };
  }
  if (!run) {
    if (ciRuns === 0 && waitedMs >= graceMs) {
      return {
        state: 'fail',
        why: `no CI run exists for this commit after ${graceMs / 60_000} min (a [skip ci] push never gets one)`,
      };
    }
    return { state: 'wait', why: `no ${CHECK_NAME} check run yet` };
  }
  if (run.status !== 'completed') {
    return { state: 'wait', why: `${CHECK_NAME} is ${run.status}` };
  }
  if (run.conclusion === 'success') {
    return { state: 'deploy', why: `${CHECK_NAME} passed` };
  }
  return {
    state: 'fail',
    why: `${CHECK_NAME} concluded ${run.conclusion}`,
  };
}

async function api(path, accept = 'application/vnd.github+json') {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetch(`${base}${path}`, {
    headers: {
      accept,
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const err = new Error(
      `GET ${path}: HTTP ${res.status} ${await res.text()}`,
    );
    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const limited =
      [403, 429].includes(res.status) &&
      (retryAfter > 0 || res.headers.get('x-ratelimit-remaining') === '0');
    if (limited) {
      // A (secondary) rate limit clears on its own: wait it out.
      err.retryAfterMs =
        retryAfter > 0
          ? retryAfter * 1000
          : Math.max(0, reset * 1000 - Date.now());
    } else {
      // 401/403/404/422 will not fix themselves (missing permission, unknown sha).
      err.fatal = [401, 403, 404, 422].includes(res.status);
    }
    throw err;
  }
  return accept.endsWith('.sha') ? (await res.text()).trim() : res.json();
}

// The ci-ok to judge: newest one on SHA from a push-event ci.yml run. A
// manual (workflow_dispatch) CI run posts its own ci-ok on the same sha, and
// it may be a debug run that fails or sits on a tmate shell; it must neither
// shadow nor stand in for the push run. filter=latest already keeps only the
// newest attempt per check suite, so a re-run push CI still wins.
export function pickRun(checkRuns, pushSuiteIds, sha) {
  return (
    checkRuns
      .filter((r) => r.head_sha === sha && pushSuiteIds.has(r.check_suite?.id))
      .toSorted((a, b) => b.id - a.id)[0] ?? null
  );
}

async function readState(repo, sha) {
  const wf = await api(
    `/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const pushSuiteIds = new Set(wf.workflow_runs.map((r) => r.check_suite_id));
  const q = new URLSearchParams({
    check_name: CHECK_NAME,
    filter: 'latest',
    app_id: String(GITHUB_ACTIONS_APP_ID),
  });
  const runs = await api(`/repos/${repo}/commits/${sha}/check-runs?${q}`);
  const run = pickRun(runs.check_runs, pushSuiteIds, sha);
  const head = await api(
    `/repos/${repo}/commits/master`,
    'application/vnd.github.sha',
  );
  return { run, head, ciRuns: wf.total_count };
}

async function main() {
  const { GITHUB_REPOSITORY: repo, SHA: sha, GITHUB_OUTPUT } = process.env;
  if (!repo || !sha || !process.env.GITHUB_TOKEN) {
    console.error(
      '::error::ci-gate needs GITHUB_REPOSITORY, SHA and GITHUB_TOKEN',
    );
    process.exit(1);
  }
  const timeoutMs = Number(process.env.TIMEOUT_MIN || 60) * 60_000;
  const graceMs = Number(process.env.NO_CI_GRACE_MIN || 5) * 60_000;
  const intervalMs = Number(process.env.INTERVAL_S || 30) * 1000;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const finish = (deploy, code) => {
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `deploy=${deploy}\n`);
    process.exit(code);
  };

  let last = '';
  for (;;) {
    let verdict;
    let pauseMs = intervalMs;
    try {
      const state = await readState(repo, sha);
      const waitedMs = Date.now() - started;
      verdict = decide({ ...state, sha, waitedMs, graceMs });
    } catch (err) {
      if (err.fatal) {
        console.error(`::error::${err.message}`);
        finish(false, 1);
      }
      pauseMs = Math.max(intervalMs, err.retryAfterMs ?? 0);
      verdict = { state: 'wait', why: `API error, retrying: ${err.message}` };
    }
    if (verdict.why !== last) console.log(`${sha.slice(0, 9)}: ${verdict.why}`);
    last = verdict.why;

    if (verdict.state === 'deploy') finish(true, 0);
    if (verdict.state === 'superseded') {
      console.log(`::notice::Not deploying ${sha.slice(0, 9)}: ${verdict.why}`);
      finish(false, 0);
    }
    if (verdict.state === 'fail') {
      console.error(
        `::error::Not deploying ${sha.slice(0, 9)}: ${verdict.why}. Fix or re-run CI, then re-run this workflow's failed jobs.`,
      );
      finish(false, 1);
    }
    if (Date.now() + pauseMs > deadline) {
      console.error(
        `::error::Not deploying ${sha.slice(0, 9)}: ${CHECK_NAME} did not pass within ${timeoutMs / 60_000} min (${last}). A push with [skip ci] never gets one.`,
      );
      finish(false, 1);
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const run = (status, conclusion = null) => ({ status, conclusion });
  const grace = { graceMs: 5 * 60_000 };
  const cases = [
    [{ run: null, head: sha, ciRuns: 1 }, 'wait'],
    // CI not created yet: wait out the grace period, then fail fast
    [{ run: null, head: sha, ciRuns: 0, waitedMs: 60_000 }, 'wait'],
    [{ run: null, head: sha, ciRuns: 0, waitedMs: 5 * 60_000 }, 'fail'],
    [{ run: null, head: sha, ciRuns: 1, waitedMs: 30 * 60_000 }, 'wait'],
    [{ run: run('queued'), head: sha }, 'wait'],
    [{ run: run('in_progress'), head: sha }, 'wait'],
    [{ run: run('completed', 'success'), head: sha }, 'deploy'],
    // master moved on: this run can't ship SHA (App Platform builds the tip)
    [{ run: run('in_progress'), head: newer }, 'superseded'],
    [{ run: run('completed', 'success'), head: newer }, 'superseded'],
    [{ run: run('completed', 'cancelled'), head: newer }, 'superseded'],
    // ci-ok concludes failure when a newer push cancels its needs
    [{ run: run('completed', 'failure'), head: newer }, 'superseded'],
    [
      { run: null, head: newer, ciRuns: 0, waitedMs: 10 * 60_000 },
      'superseded',
    ],
    // a cancel with nothing newer is a real failure
    [{ run: run('completed', 'cancelled'), head: sha }, 'fail'],
    [{ run: run('completed', 'cancelled'), head: '' }, 'fail'],
    [{ run: run('completed', 'failure'), head: sha }, 'fail'],
    [{ run: run('completed', 'skipped'), head: sha }, 'fail'],
    [{ run: run('completed', 'timed_out'), head: sha }, 'fail'],
    [{ run: run('completed', 'neutral'), head: sha }, 'fail'],
    [{ run: run('completed', 'action_required'), head: sha }, 'fail'],
    [{ run: run('completed', 'startup_failure'), head: sha }, 'fail'],
    [{ run: run('completed', 'stale'), head: sha }, 'fail'],
  ];
  // Push vs manual CI runs on the same sha: suite 1 is the push run, suite 2
  // a later workflow_dispatch run.
  const check = (id, suite, status, conclusion = null) => ({
    id,
    head_sha: sha,
    check_suite: { id: suite },
    status,
    conclusion,
  });
  const push = new Set([1]);
  const picked = [
    // dispatch failure newer than push success: still judged on the push run
    [
      [
        check(10, 1, 'completed', 'success'),
        check(20, 2, 'completed', 'failure'),
      ],
      push,
      1,
      'deploy',
    ],
    // dispatch still running (tmate) after a green push run: deploy
    [
      [check(10, 1, 'completed', 'success'), check(20, 2, 'in_progress')],
      push,
      1,
      'deploy',
    ],
    // dispatch success while the push run failed: the dispatch can't stand in
    [
      [
        check(10, 1, 'completed', 'failure'),
        check(20, 2, 'completed', 'success'),
      ],
      push,
      1,
      'fail',
    ],
    // dispatch-only: no push run yet, so wait, then fail once the grace is up
    [[check(20, 2, 'completed', 'success')], new Set(), 0, 'wait'],
    [[check(20, 2, 'completed', 'success')], new Set(), 0, 'fail', 5 * 60_000],
    // a ci-ok on another sha never counts
    [
      [{ ...check(10, 1, 'completed', 'success'), head_sha: newer }],
      push,
      1,
      'wait',
    ],
  ];
  for (const [checks, suites, ciRuns, want, waitedMs = 0] of picked) {
    cases.push([
      { run: pickRun(checks, suites, sha), head: sha, ciRuns, waitedMs },
      want,
    ]);
  }
  let failed = 0;
  for (const [input, want] of cases) {
    const got = decide({ ...grace, ...input, sha }).state;
    if (got !== want) {
      failed++;
      console.error(
        `FAIL ${JSON.stringify(input.run)} head=${input.head.slice(0, 1)} -> ${got}, want ${want}`,
      );
    }
  }
  console.log(
    failed ? `${failed} failed` : `all ${cases.length} checks passed`,
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === '--test') selfTest();
else await main();
