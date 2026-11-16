#!/usr/bin/env node
// Waits for master CI to pass on a commit before deploy.yml deploys it.
//
// Polls the `ci-ok` check run (ci.yml's aggregate job, posted by the GitHub
// Actions app) on SHA until it completes. Only `success` deploys. One case
// skips quietly instead of failing: CI was cancelled because a newer push
// replaced it (ci.yml cancels superseded master runs), so the newer push's
// Deploy run ships this commit too, from its live-commit diff.
// Anything else (failure, timed_out, skipped, a cancel on the current master
// head, no ci-ok within TIMEOUT_MIN) fails the gate and nothing deploys.
//
//   node .github/scripts/ci-gate.mjs          CI: reads env, writes deploy=true|false
//   node .github/scripts/ci-gate.mjs --test   built-in self-check
//
// Env: GITHUB_TOKEN (checks: read), GITHUB_REPOSITORY, SHA, optional
// TIMEOUT_MIN (default 60), INTERVAL_S (default 30), GITHUB_API_URL.

import { appendFileSync } from 'node:fs';

const CHECK_NAME = 'ci-ok';
const GITHUB_ACTIONS_APP_ID = 15368; // ignore same-named checks from other apps

// run: the latest ci-ok check run on SHA, or null if none exists yet.
// head: the commit master points at now.
// Returns { state: 'wait' | 'deploy' | 'superseded' | 'fail', why }.
export function decide({ run, head, sha }) {
  if (!run) return { state: 'wait', why: `no ${CHECK_NAME} check run yet` };
  if (run.status !== 'completed') {
    return { state: 'wait', why: `${CHECK_NAME} is ${run.status}` };
  }
  if (run.conclusion === 'success') {
    return { state: 'deploy', why: `${CHECK_NAME} passed` };
  }
  if (run.conclusion === 'cancelled' && head && head !== sha) {
    return {
      state: 'superseded',
      why: `CI was cancelled and master moved on to ${head.slice(0, 9)}; that push's Deploy run ships this commit`,
    };
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
    // 401/403/404/422 will not fix themselves (missing `checks: read`, unknown sha).
    err.fatal = [401, 403, 404, 422].includes(res.status);
    throw err;
  }
  return accept.endsWith('.sha') ? (await res.text()).trim() : res.json();
}

async function readState(repo, sha) {
  const q = new URLSearchParams({
    check_name: CHECK_NAME,
    filter: 'latest',
    app_id: String(GITHUB_ACTIONS_APP_ID),
  });
  const runs = await api(`/repos/${repo}/commits/${sha}/check-runs?${q}`);
  // filter=latest keeps the newest attempt per check suite; a re-run CI is
  // its newest attempt, so the highest id wins.
  const run =
    runs.check_runs
      .toSorted((a, b) => b.id - a.id)
      .find((r) => r.head_sha === sha) ?? null;
  const head = await api(
    `/repos/${repo}/commits/master`,
    'application/vnd.github.sha',
  );
  return { run, head };
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
  const intervalMs = Number(process.env.INTERVAL_S || 30) * 1000;
  const deadline = Date.now() + timeoutMs;
  const finish = (deploy, code) => {
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `deploy=${deploy}\n`);
    process.exit(code);
  };

  let last = '';
  for (;;) {
    let verdict;
    try {
      verdict = decide({ ...(await readState(repo, sha)), sha });
    } catch (err) {
      if (err.fatal) {
        console.error(`::error::${err.message}`);
        finish(false, 1);
      }
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
    if (Date.now() + intervalMs > deadline) {
      console.error(
        `::error::Not deploying ${sha.slice(0, 9)}: ${CHECK_NAME} did not pass within ${timeoutMs / 60_000} min (${last}). A push with [skip ci] never gets one.`,
      );
      finish(false, 1);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const run = (status, conclusion = null) => ({ status, conclusion });
  const cases = [
    [{ run: null, head: sha }, 'wait'],
    [{ run: run('queued'), head: sha }, 'wait'],
    [{ run: run('in_progress'), head: newer }, 'wait'],
    [{ run: run('completed', 'success'), head: sha }, 'deploy'],
    // passed but master moved: still deploy; do-deploy.sh's head check skips it
    [{ run: run('completed', 'success'), head: newer }, 'deploy'],
    [{ run: run('completed', 'cancelled'), head: newer }, 'superseded'],
    // a cancel with nothing newer is a real failure
    [{ run: run('completed', 'cancelled'), head: sha }, 'fail'],
    [{ run: run('completed', 'cancelled'), head: '' }, 'fail'],
    [{ run: run('completed', 'failure'), head: newer }, 'fail'],
    [{ run: run('completed', 'skipped'), head: sha }, 'fail'],
    [{ run: run('completed', 'timed_out'), head: sha }, 'fail'],
    [{ run: run('completed', 'neutral'), head: sha }, 'fail'],
    [{ run: run('completed', 'action_required'), head: sha }, 'fail'],
    [{ run: run('completed', 'startup_failure'), head: sha }, 'fail'],
    [{ run: run('completed', 'stale'), head: sha }, 'fail'],
  ];
  let failed = 0;
  for (const [input, want] of cases) {
    const got = decide({ ...input, sha }).state;
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
