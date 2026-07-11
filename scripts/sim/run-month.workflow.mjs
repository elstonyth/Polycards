// scripts/sim/run-month.workflow.mjs
export const meta = {
  name: 'virtual-month-sim',
  description:
    'Run the adversarial virtual-month simulation against the sim backend',
  phases: [{ title: 'Day' }],
};

// args: { runId, days, startDay?, activePersonas?: string[] }
// `startDay` (default 1) continues an existing run: day labels, diaries, and
// artifacts pick up where the previous launch stopped. The caller is
// responsible for the BOUNDARY shift into startDay (the previous launch's
// last day never shifts) — this loop only shifts between its own days.
// Tolerate args arriving as a JSON string (the launcher may stringify it).
const A = typeof args === 'string' ? JSON.parse(args) : args || {};
const runId = A.runId;
const days = A.days ?? 2;
const startDay = A.startDay ?? 1;
if (!runId) throw new Error('args.runId is required');

const CUSTOMERS = A.activePersonas ?? ['honest', 'refund-seeker'];

// Declared BEFORE the loop: this is a `const`, so referencing it from inside
// the loop before its declaration line would be a temporal-dead-zone
// ReferenceError. (The prompt builders below are function declarations and are
// hoisted, but keep everything above the loop so nothing trails the final
// `return`.)
const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'output'],
  properties: {
    ok: { type: 'boolean' },
    output: { type: 'string' },
  },
};

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'day',
    'invariantsPassed',
    'confirmed',
    'unverified',
    'showstopper',
  ],
  properties: {
    day: { type: 'integer' },
    invariantsPassed: { type: 'boolean' },
    confirmed: { type: 'integer' },
    unverified: { type: 'integer' },
    showstopper: { type: 'boolean' },
  },
};

// --- prompt builders: each reads the charter file and pins the run context ---
function base(runId, day) {
  // :9100 — keep in sync with SIM.backendUrl in config.mjs (this sandbox
  // cannot import it).
  return `Run id: ${runId}. Simulated day: ${day}. Artifacts under scripts/sim/runs/${runId}/. Backend: http://localhost:9100. Publishable key: read runs/${runId}/pk.txt.`;
}
function customerPrompt(p, runId, day) {
  return `${base(runId, day)}\n\nFollow your charter exactly: scripts/sim/personas/${p}.md`;
}
function adminPrompt(runId, day) {
  return `${base(runId, day)}\n\nFollow your charter exactly: scripts/sim/personas/admin.md`;
}
function auditorPrompt(runId, day) {
  return `${base(runId, day)}\n\nFollow your charter exactly: scripts/sim/personas/auditor.md`;
}

// A customer agent whose model response STALLS MID-STREAM dies and agent()
// returns null after its own internal retries (hit live 2026-07-11:
// cust:buyback-haggler:d4 stalled → the persona silently dropped its whole day,
// leaving that day's adversarial coverage incomplete and corrupting the
// "clean day" signal). Re-run a null/empty return up to 3x total. A persona
// that legitimately did little still returns a non-empty summary string, so
// this only re-fires on a genuine death, not on a quiet day.
async function runCustomer(p, runId, day) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await agent(customerPrompt(p, runId, day), {
      label:
        attempt === 1
          ? `cust:${p}:d${day}`
          : `cust:${p}:d${day}:retry${attempt - 1}`,
      phase: 'Day',
      model: 'opus',
    });
    if (typeof out === 'string' && out.trim() !== '') return out;
    log(
      `Day ${day} — ${p} agent returned null/empty (attempt ${attempt}/3) — ${attempt < 3 ? 'retrying' : 'giving up; day is persona-incomplete'}`,
    );
  }
  return null;
}

// Identity guard BEFORE any agent acts (spec §4): a dev backend on the sim
// port answers /health against the WRONG db, so preflight.mjs additionally
// proves this run's publishable key + sim admin work. Abort loudly otherwise —
// never let eight adversarial agents loose on a non-sim database. (Same
// sandbox constraint as the day shift: no Node here, delegate to a Bash agent.)
log('Preflight — verifying the backend is the provisioned sim backend');
const pre = await agent(
  `Run EXACTLY this one shell command from the repo root and report the ` +
    `result — do nothing else:\n\n` +
    `node scripts/sim/preflight.mjs ${runId}\n\n` +
    `Set ok=true ONLY if it exited 0. Put its final stdout/stderr line in ` +
    `output verbatim.`,
  {
    label: 'preflight',
    phase: 'Day',
    model: 'haiku',
    schema: PREFLIGHT_SCHEMA,
  },
);
if (!pre?.ok) {
  throw new Error(
    `Preflight failed — aborting before any agent acts: ${pre?.output ?? 'no output from the preflight agent'}`,
  );
}

const lastDay = startDay + days - 1;
for (let day = startDay; day <= lastDay; day++) {
  phase('Day');
  log(`Day ${day} — customers acting`);

  // Customers act in batches of 4 (Knex pool cap — 8 concurrent agents can
  // exhaust the backend's DB pool). Their summaries aren't read here: the agents'
  // real output is the artifacts they write (events, inbox, findings). Await for
  // sequencing only.
  const CHUNK = 4;
  for (let i = 0; i < CUSTOMERS.length; i += CHUNK) {
    await parallel(
      CUSTOMERS.slice(i, i + CHUNK).map(
        (p) => () => runCustomer(p, runId, day),
      ),
    );
  }

  log(`Day ${day} — admin working the inbox`);
  await agent(adminPrompt(runId, day), {
    label: `admin:d${day}`,
    phase: 'Day',
    model: 'opus',
  });

  log(`Day ${day} — auditor closing the day`);
  const audit = await agent(auditorPrompt(runId, day), {
    label: `audit:d${day}`,
    phase: 'Day',
    model: 'opus',
    schema: AUDIT_SCHEMA,
  });

  if (audit?.showstopper) {
    log(`Day ${day} — SHOWSTOPPER declared; pausing the run for a hotfix`);
    return { stoppedAt: day, reason: 'showstopper', audit };
  }

  if (day < lastDay) {
    log(`Day ${day} — time-shifting the world back one day`);
    // The workflow sandbox has no Node/fs/child_process and bans dynamic
    // import(), so the DB shift (docker exec psql) can't run in-workflow.
    // Delegate to a Bash-capable agent that runs the CLI (reads db.json for
    // creds via the runId arg).
    await agent(
      `Run EXACTLY this one shell command from the repo root and report its ` +
        `output verbatim — do nothing else:\n\n` +
        `node scripts/sim/time-shift-exec.mjs 1 ${runId}\n\n` +
        `It shifts the sim Postgres back one day and flushes the sim Redis so ` +
        `day ${day + 1}'s daily draws and time-gated accruals re-fire. If it ` +
        `errors, report the exact error.`,
      { label: `shift:d${day}`, phase: 'Day', model: 'haiku' },
    );
  }
}

return { runId, startDay, days, complete: true };
