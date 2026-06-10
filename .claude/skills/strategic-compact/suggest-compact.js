#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- Intentional CommonJS: this is a Node PreToolUse hook script (wired in .claude/settings.json, run as `node suggest-compact.js`). The project is CommonJS (no "type":"module"), so require() is the correct runtime form; ESM imports would throw at runtime. */
/**
 * strategic-compact — PreToolUse hook
 *
 * Counts tool invocations per session and emits a NON-BLOCKING suggestion to
 * run /compact once a configurable threshold is reached (default 50), then
 * periodically (default every 25 calls) thereafter.
 *
 * Why this exists: the strategic-compact SKILL.md documents this script, but
 * upstream ECC never shipped it. This is a from-scratch implementation of the
 * documented contract, modeled on this repo's graphify PreToolUse hook
 * (.claude/settings.json) which surfaces guidance via `additionalContext`.
 *
 * Contract:
 *   - stdin: PreToolUse hook JSON (we only read `session_id`).
 *   - stdout (on trigger only): { hookSpecificOutput: { hookEventName, additionalContext } }
 *   - exit code: always 0. The hook must NEVER block or fail a tool call.
 *
 * Config (env):
 *   - COMPACT_THRESHOLD  first suggestion after N calls (default 50)
 *   - COMPACT_INTERVAL   remind every N calls after threshold (default 25)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || "50", 10) || 50;
const INTERVAL = parseInt(process.env.COMPACT_INTERVAL || "25", 10) || 25;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  let sessionId = "default";
  try {
    const raw = readStdin();
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data.session_id === "string" && data.session_id) {
        sessionId = data.session_id;
      }
    }
  } catch {
    // Malformed/empty input — fall back to the default session bucket.
  }

  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const counterFile = path.join(os.tmpdir(), `strategic-compact-${safeId}.count`);

  let count = 0;
  try {
    count = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  try {
    fs.writeFileSync(counterFile, String(count));
  } catch {
    // If state can't be persisted, degrade silently rather than block edits.
  }

  const atThreshold = count === THRESHOLD;
  const afterThreshold = count > THRESHOLD && (count - THRESHOLD) % INTERVAL === 0;
  if (!atThreshold && !afterThreshold) {
    return; // Below threshold or between reminders — stay silent (exit 0).
  }

  const msg =
    `strategic-compact: ${count} tool calls this session (threshold ${THRESHOLD}). ` +
    `Consider running /compact at the next logical phase boundary — summarize ` +
    `completed work before starting the next phase to preserve context. ` +
    `Invoke the strategic-compact skill for the full compaction decision guide.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: msg,
      },
    })
  );
}

try {
  main();
} catch {
  // Never let the hook throw in a way that could interfere with the tool call.
}
process.exit(0);
