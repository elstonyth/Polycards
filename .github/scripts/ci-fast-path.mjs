#!/usr/bin/env node
// Master-CI fast path, used by ci.yml's `changes` job.
//
// A squash merge to master usually lands the exact tree its PR already tested.
// When it does, re-running backend-unit, integration-http and
// integration-modules on the master push proves nothing new, so this script
// lets ci.yml skip them. backend-quality always runs (it saves the caches).
//
// The push is fast-pathed only when ALL of these hold:
//   1. the event is a push to refs/heads/master;
//   2. exactly one merged PR into master has merge_commit_sha == SHA;
//   3. that PR's head commit has the same tree as SHA (catches an admin merge
//      that skipped "branch must be up to date", or any rewrite);
//   4. on that head sha, the newest GitHub Actions `ci-ok` check run completed
//      with success, and so did the newest run of every backend-unit,
//      integration-http and integration-modules check (at least one each), so
//      the jobs we skip really ran and passed on this tree.
// Anything else, including any API or git error, means a full run. The live
// mode never exits non-zero: a failed `changes` job would fail ci-ok on master
// and block the deploy.
//
//   node .github/scripts/ci-fast-path.mjs            CI: reads env, writes fast=true|false to GITHUB_OUTPUT
//   node .github/scripts/ci-fast-path.mjs --sha SHA  what a master push of SHA would decide (GH_TOKEN or gh auth)
//   node .github/scripts/ci-fast-path.mjs --test     offline self-check, incl. the backend-gate/ci-ok contract

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Job names in ci.yml that the fast path skips. Matrix jobs report one check
// run per leg, e.g. "integration-http (3)".
export const SKIPPED_JOBS = [
  'backend-unit',
  'integration-http',
  'integration-modules',
];
const ACTIONS_APP = 'github-actions';

const newest = (runs) =>
  runs.reduce((a, b) => (a === null || b.id > a.id ? b : a), null);
const passed = (run) =>
  run !== null && run.status === 'completed' && run.conclusion === 'success';

// api(path) resolves to parsed JSON for /repos/{owner}/{repo}/{path}, or throws.
export async function decide({ event, ref, sha, shaTree, api }) {
  const no = (reason) => ({ fast: false, reason });
  if (event !== 'push' || ref !== 'refs/heads/master')
    return no(`not a push to master (${event} ${ref})`);
  if (!sha || !shaTree) return no('missing sha or tree');
  try {
    const prs = (await api(`commits/${sha}/pulls`)).filter(
      (p) =>
        p.merged_at && p.merge_commit_sha === sha && p.base?.ref === 'master',
    );
    if (prs.length !== 1)
      return no(
        `${prs.length} merged PRs have merge commit ${sha.slice(0, 9)}`,
      );
    const pr = prs[0];
    const head = pr.head?.sha;
    if (!head) return no(`PR #${pr.number} has no head sha`);
    const headTree = (await api(`git/commits/${head}`)).tree?.sha;
    if (headTree !== shaTree)
      return no(
        `PR #${pr.number} head ${head.slice(0, 9)} tree differs from ${sha.slice(0, 9)}`,
      );
    const checks = await api(
      `commits/${head}/check-runs?filter=all&per_page=100`,
    );
    const runs = (checks.check_runs ?? []).filter(
      (r) => r.app?.slug === ACTIONS_APP,
    );
    if ((checks.total_count ?? 0) > 100)
      return no(`more than 100 check runs on ${head.slice(0, 9)}`);
    const ciOk = newest(runs.filter((r) => r.name === 'ci-ok'));
    if (!passed(ciOk))
      return no(
        `newest ci-ok on PR #${pr.number} head ${head.slice(0, 9)} is ${ciOk ? `${ciOk.status}/${ciOk.conclusion}` : 'missing'}`,
      );
    for (const job of SKIPPED_JOBS) {
      const names = new Set(
        runs
          .filter((r) => r.name === job || r.name.startsWith(`${job} (`))
          .map((r) => r.name),
      );
      if (names.size === 0)
        return no(`${job} never ran on PR #${pr.number} head`);
      for (const name of names) {
        const run = newest(runs.filter((r) => r.name === name));
        if (!passed(run))
          return no(`newest "${name}" on PR #${pr.number} head did not pass`);
      }
    }
    return {
      fast: true,
      reason: `PR #${pr.number} head ${head.slice(0, 9)} has this tree and passed ci-ok`,
    };
  } catch (err) {
    return no(`lookup failed: ${err.message}`);
  }
}

function githubApi(token, repo, base = 'https://api.github.com') {
  return async (path) => {
    const res = await fetch(`${base}/repos/${repo}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  };
}

const treeOf = (sha) =>
  execFileSync('git', ['rev-parse', `${sha}^{tree}`], {
    encoding: 'utf8',
  }).trim();

// ---------------------------------------------------------------- self-check

const HERE = dirname(fileURLToPath(import.meta.url));

// The `run:` block of the step named `stepName` in ci.yml, dedented.
// shortcut: line-based, assumes `run: |` directly under the step; fails loudly
// (throws) rather than guess if the layout changes.
export function runBlock(yml, stepName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (at < 0) throw new Error(`step "${stepName}" not found in ci.yml`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  if (runAt < 0 || lines.slice(at + 1, runAt).some((l) => /^\s*- /.test(l)))
    throw new Error(`step "${stepName}" has no run: | block`);
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== '' && l.search(/\S/) <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return body.join('\n');
}

// The job's `if:` line in ci.yml (top-level jobs are indented two spaces).
export function jobIf(yml, job) {
  const m = yml.match(
    new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|$)`),
  );
  if (!m) throw new Error(`job "${job}" not found in ci.yml`);
  return (m[1].match(/^ {4}if: (.*)$/m) ?? [])[1] ?? '';
}

// GitHub runs `run:` with `bash -e {0}`; -c is the same shell semantics.
function runGate(script, results) {
  try {
    execFileSync('bash', ['-e', '-c', script], {
      env: { ...process.env, RESULTS: JSON.stringify(results, null, 2) },
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

async function selfTest() {
  let failed = 0;
  const fail = (msg) => {
    failed++;
    console.error(`FAIL ${msg}`);
  };
  let count = 0;

  // --- decision cases, against a fake API
  const SHA = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);
  const TREE = 'c'.repeat(40);
  const run = (id, name, conclusion = 'success', slug = ACTIONS_APP) => ({
    id,
    name,
    status: 'completed',
    conclusion,
    app: { slug },
  });
  const greenRuns = [
    run(1, 'changes'),
    run(2, 'backend-quality'),
    run(3, 'backend-unit (1)'),
    run(4, 'backend-unit (2)'),
    ...Array.from({ length: 10 }, (_, i) =>
      run(5 + i, `integration-http (${i + 1})`),
    ),
    run(15, 'integration-modules'),
    run(16, 'backend-gate'),
    run(17, 'ci-ok'),
  ];
  const pr = {
    number: 1060,
    merged_at: '2026-11-16T00:00:00Z',
    merge_commit_sha: SHA,
    base: { ref: 'master' },
    head: { sha: HEAD },
  };
  const fake =
    ({ prs = [pr], headTree = TREE, runs = greenRuns, total, throwOn } = {}) =>
    async (path) => {
      if (throwOn && path.startsWith(throwOn)) throw new Error('HTTP 502');
      if (path === `commits/${SHA}/pulls`) return prs;
      if (path === `git/commits/${HEAD}`) return { tree: { sha: headTree } };
      if (path.startsWith(`commits/${HEAD}/check-runs`))
        return { total_count: total ?? runs.length, check_runs: runs };
      throw new Error(`unexpected ${path}`);
    };
  const base = {
    event: 'push',
    ref: 'refs/heads/master',
    sha: SHA,
    shaTree: TREE,
  };
  const without = (name) => greenRuns.filter((r) => r.name !== name);
  const cases = [
    ['all green', {}, {}, true],
    ['pull_request event', { event: 'pull_request' }, {}, false],
    ['workflow_dispatch event', { event: 'workflow_dispatch' }, {}, false],
    ['push to another branch', { ref: 'refs/heads/feature' }, {}, false],
    ['no PR for the commit', {}, { prs: [] }, false],
    ['PR not merged', {}, { prs: [{ ...pr, merged_at: null }] }, false],
    [
      'merge_commit_sha differs',
      {},
      { prs: [{ ...pr, merge_commit_sha: HEAD }] },
      false,
    ],
    [
      'PR into another base',
      {},
      { prs: [{ ...pr, base: { ref: 'release' } }] },
      false,
    ],
    ['two matching PRs', {}, { prs: [pr, { ...pr, number: 1061 }] }, false],
    ['head tree differs', {}, { headTree: 'd'.repeat(40) }, false],
    ['no ci-ok', {}, { runs: without('ci-ok') }, false],
    [
      'ci-ok failed',
      {},
      { runs: [...without('ci-ok'), run(17, 'ci-ok', 'failure')] },
      false,
    ],
    [
      'ci-ok success then re-run failed',
      {},
      { runs: [...greenRuns, run(40, 'ci-ok', 'failure')] },
      false,
    ],
    [
      'ci-ok failed then re-run passed',
      {},
      {
        runs: [
          ...without('ci-ok'),
          run(17, 'ci-ok', 'failure'),
          run(41, 'ci-ok'),
        ],
      },
      true,
    ],
    [
      'ci-ok still in progress',
      {},
      {
        runs: [
          ...without('ci-ok'),
          { ...run(17, 'ci-ok'), status: 'in_progress', conclusion: null },
        ],
      },
      false,
    ],
    [
      'ci-ok from another app only',
      {},
      { runs: [...without('ci-ok'), run(17, 'ci-ok', 'success', 'imposter')] },
      false,
    ],
    [
      'backend jobs never ran (skipped on PR)',
      {},
      {
        runs: greenRuns.filter(
          (r) => !/^(backend-unit|integration-)/.test(r.name),
        ),
      },
      false,
    ],
    [
      'one http shard skipped',
      {},
      {
        runs: [
          ...without('integration-http (4)'),
          run(8, 'integration-http (4)', 'skipped'),
        ],
      },
      false,
    ],
    [
      'http shard failed then re-run passed',
      {},
      {
        runs: [
          ...without('integration-http (4)'),
          run(8, 'integration-http (4)', 'failure'),
          run(42, 'integration-http (4)'),
        ],
      },
      true,
    ],
    ['over 100 check runs', {}, { total: 150 }, false],
    ['API error', {}, { throwOn: 'git/commits' }, false],
    ['missing tree', { shaTree: '' }, {}, false],
  ];
  for (const [name, input, api, want] of cases) {
    count++;
    const got = await decide({ ...base, ...input, api: fake(api) });
    if (got.fast !== want)
      fail(
        `decide "${name}" -> fast=${got.fast} (${got.reason}), want ${want}`,
      );
  }

  // --- contract: fast-path-skipped jobs must read as passing in the REAL
  // backend-gate and ci-ok scripts from ci.yml, or every fast-pathed master
  // push fails ci-ok and the deploy gate (which waits on ci-ok) never deploys.
  const yml = readFileSync(join(HERE, '..', 'workflows', 'ci.yml'), 'utf8');
  const backendGate = runBlock(yml, 'Evaluate backend job results');
  const ciOk = runBlock(yml, 'Evaluate job results');
  const r = (result, outputs = {}) => ({ result, outputs });
  // Shape copied from a real backend-gate log (toJSON(needs)).
  const changes = r('success', {
    backend: 'true',
    fast: 'true',
    storefront: 'false',
  });
  const fastGate = {
    changes,
    'backend-quality': r('success'),
    'backend-unit': r('skipped'),
    'integration-http': r('skipped'),
    'integration-modules': r('skipped'),
  };
  const okNeeds = {
    changes,
    lint: r('success'),
    storefront: r('skipped'),
    'backend-gate': r('success'),
    gitleaks: r('success'),
  };
  const gateCases = [
    ['backend-gate, fast path', backendGate, fastGate, 0],
    [
      'backend-gate, a skipped job failed instead',
      backendGate,
      { ...fastGate, 'integration-http': r('failure') },
      1,
    ],
    [
      'backend-gate, backend-quality cancelled',
      backendGate,
      { ...fastGate, 'backend-quality': r('cancelled') },
      1,
    ],
    ['ci-ok, fast path', ciOk, okNeeds, 0],
    [
      'ci-ok, backend-gate failed',
      ciOk,
      { ...okNeeds, 'backend-gate': r('failure') },
      1,
    ],
  ];
  for (const [name, script, results, want] of gateCases) {
    count++;
    const got = runGate(script, results) === 0 ? 0 : 1;
    if (got !== want) fail(`gate "${name}" exited ${got}, want ${want}`);
  }

  // --- wiring: exactly the three test jobs carry the fast-path guard.
  for (const job of [...SKIPPED_JOBS, 'backend-quality']) {
    count++;
    const guarded = jobIf(yml, job).includes(
      "needs.changes.outputs.fast != 'true'",
    );
    const want = job !== 'backend-quality';
    if (guarded !== want)
      fail(`job ${job} fast-path guard=${guarded}, want ${want}`);
  }
  count++;
  if (!/^ {6}fast: \$\{\{ steps\.fastpath\.outputs\.fast \}\}$/m.test(yml))
    fail('changes job does not expose outputs.fast from steps.fastpath');

  console.log(failed ? `${failed} failed` : `all ${count} checks passed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- entry

const args = process.argv.slice(2);
if (args[0] === '--test') {
  await selfTest();
} else if (args[0] === '--sha') {
  const sha = execFileSync('git', ['rev-parse', args[1]], {
    encoding: 'utf8',
  }).trim();
  const token =
    process.env.GH_TOKEN ||
    execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const repo = process.env.GITHUB_REPOSITORY || 'elstonyth/Polycards';
  const got = await decide({
    event: 'push',
    ref: 'refs/heads/master',
    sha,
    shaTree: treeOf(sha),
    api: githubApi(token, repo),
  });
  console.log(`fast=${got.fast} (${got.reason})`);
} else {
  const env = process.env;
  let got;
  try {
    got = await decide({
      event: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
      sha: env.SHA,
      shaTree: env.SHA ? treeOf(env.SHA) : '',
      api: githubApi(env.GH_TOKEN, env.GITHUB_REPOSITORY, env.GITHUB_API_URL),
    });
  } catch (err) {
    got = { fast: false, reason: `error: ${err.message}` };
  }
  console.log(`fast=${got.fast} (${got.reason})`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `fast=${got.fast}\n`);
}
