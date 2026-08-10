// Drive the DigitalOcean App Platform console over its raw WebSocket.
//
// `doctl apps console` puts the local terminal into raw mode; under any shell
// whose stdout is a pipe (agent harness, VS Code terminal, CI) that fails with
// "error getting terminal size: The handle is invalid" and there is no flag to
// opt out. The console is only a WebSocket underneath, so talk to it directly.
//
//   node do-exec.mjs <app-id> <component> "<command>"
//
// Wire format, confirmed by probe: both directions are JSON envelopes,
// {"op":"stdout"|"stdin","data":"..."}. Sending a bare string closes the
// socket with 1006. Token is read from the doctl config and never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [appId, component, command] = process.argv.slice(2);
if (!appId || !component || !command) {
  console.error('usage: do-exec.mjs <app-id> <component> "<command>"');
  process.exit(2);
}

// Same locations doctl itself uses, so this works wherever doctl is set up.
const doctlConfig = () => {
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA ?? '', 'doctl', 'config.yaml');
  if (process.platform === 'darwin')
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'doctl',
      'config.yaml',
    );
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'doctl',
    'config.yaml',
  );
};

const cfgPath = doctlConfig();
const token =
  process.env.DIGITALOCEAN_ACCESS_TOKEN ||
  (fs.existsSync(cfgPath)
    ? fs.readFileSync(cfgPath, 'utf8').match(/access-token:\s*(\S+)/)?.[1]
    : undefined);
if (!token) {
  console.error(
    `no token: set DIGITALOCEAN_ACCESS_TOKEN or run \`doctl auth init\` (${cfgPath})`,
  );
  process.exit(2);
}

const api = async (path) => {
  const res = await fetch(`https://api.digitalocean.com/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok)
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};

const { app } = await api(`/apps/${appId}`);
const deploymentId = app.active_deployment.id;
console.error(
  `[exec] app=${app.spec.name} component=${component} deployment=${deploymentId}`,
);

const { url } = await api(
  `/apps/${appId}/deployments/${deploymentId}/components/${component}/exec`,
);

// The console never hangs up on its own, so the command announces its own end.
const SENTINEL = '__DO_EXEC_DONE__';
const ws = new WebSocket(url);
const HARD_MS = 300_000;
let seen = '';
let exitCode = 1;

const finish = (code) => {
  try {
    ws.close();
  } catch {}
  process.exit(code);
};
const hard = setTimeout(() => {
  console.error('\n[exec] hard timeout — no sentinel');
  finish(1);
}, HARD_MS);

ws.onopen = () => {
  console.error('[exec] connected');
  ws.send(
    JSON.stringify({ op: 'stdin', data: `${command}; echo ${SENTINEL}$?\n` }),
  );
};

ws.onmessage = (ev) => {
  const raw =
    typeof ev.data === 'string'
      ? ev.data
      : Buffer.from(ev.data).toString('utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let text = line;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.data === 'string') text = parsed.data;
    } catch {
      // Partial frame or non-JSON noise: pass it through rather than drop it.
    }
    // Strip ANSI SGR/OSC and bracketed-paste so the log stays greppable.
    text = text.replace(/\][^]*/g, '').replace(/\[[0-9;?]*[A-Za-z]/g, '');
    process.stdout.write(text);
    seen += text;
  }
  // The echoed command itself contains the sentinel; the real one is followed
  // by a digit at the start of a line of output.
  const hit = seen.match(new RegExp(`${SENTINEL}(\\d+)\\s`));
  if (hit) {
    exitCode = Number(hit[1]);
    clearTimeout(hard);
    process.stdout.write(`\n[exec] command exit=${exitCode}\n`);
    // Propagate the remote status. Exiting 0 regardless would let a failed
    // preflight read as a passing one — the exact silent-success this tool
    // exists to rule out.
    finish(exitCode);
  }
};

ws.onerror = (e) => {
  console.error(`[exec] socket error: ${e.message ?? e}`);
  finish(1);
};
ws.onclose = (e) => {
  clearTimeout(hard);
  console.error(
    `[exec] closed ${e.code} — no sentinel, command status unknown`,
  );
  process.exit(1);
};
