#!/usr/bin/env node
/**
 * Probe: can GlobePay365 actually reach our deposit callback, and does that
 * endpoint refuse an unsigned body?
 *
 * WHY: the single most likely way a real payment goes uncredited is that their
 * server-to-server POST never arrives — wrong NotifyUrl, DNS, a firewall, an app
 * that never deployed the route. Nothing in the test suite can catch that,
 * because every spec runs against a server we booted ourselves.
 *
 * What this DOES prove: the URL GlobePay is configured to call resolves, answers,
 * and rejects a body it cannot verify.
 * What it does NOT prove: that their side is configured with this URL, or that a
 * genuine signed callback settles. Only a real payment shows that.
 *
 * Safe to run against production: an unsigned body can never pass
 * openCallback()'s RSA check, so this cannot credit anything. It writes nothing.
 *
 *   node scripts/probe-globepay-callback.mjs https://api.polycards.gg
 *   node scripts/probe-globepay-callback.mjs            # localhost:9000
 *   node scripts/probe-globepay-callback.mjs --self-check
 *
 * Exit 0 only when the endpoint is reachable AND rejecting.
 */

const HOOK_PATH = '/hooks/globepay/deposit';
const TIMEOUT_MS = 10_000;

/**
 * Turn one attempt into a verdict. Pure, so the interesting part — which
 * outcomes are pass and which are silent failure — is checkable without a
 * server (see --self-check).
 *
 * The 2xx case is the one that matters most: the route acks with the literal
 * body "success" to stop their retries, so a reachable-but-broken deploy that
 * acked everything would look identical to a healthy one from the outside if we
 * only checked "did it answer".
 */
export function classify({ networkError, status, body }) {
  if (networkError) {
    return {
      pass: false,
      code: 'UNREACHABLE',
      detail: `no HTTP response (${networkError}) — DNS, firewall, or the host is down`,
    };
  }
  if (status === 404) {
    return {
      pass: false,
      code: 'NOT_DEPLOYED',
      detail: '404 — this build does not serve the callback route',
    };
  }
  if (status >= 200 && status < 300) {
    return {
      pass: false,
      code: 'ACCEPTS_UNSIGNED',
      detail: `${status} "${body}" — the endpoint acked a body it cannot have verified`,
    };
  }
  if (status === 400 && body.startsWith('rejected')) {
    return {
      pass: true,
      code: 'REACHABLE_AND_REJECTING',
      detail: '400 "rejected" — signature check is live',
    };
  }
  if (status === 500) {
    return {
      pass: false,
      code: 'SERVER_ERROR',
      detail: `500 "${body}" — reachable, but the route threw (missing GLOBEPAY_* env?)`,
    };
  }
  return {
    pass: false,
    code: 'UNEXPECTED',
    detail: `${status} "${body}" — not the 400 "rejected" this route returns for an unverifiable body`,
  };
}

async function attempt(url, payload) {
  // An explicit controller + clearTimeout, NOT AbortSignal.timeout(): the timer
  // that helper creates outlives the request, and on Windows/Node 24 tearing the
  // process down with it still pending trips a libuv assertion
  // (`!(handle->flags & UV_HANDLE_CLOSING)`) that turns a passing run into exit
  // 127 — fatal for a script whose whole job is to be an ops gate.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = (await res.text()).slice(0, 200).trim();
    return classify({ status: res.status, body });
  } catch (error) {
    return classify({ networkError: error.message });
  } finally {
    clearTimeout(timer);
  }
}

function selfCheck() {
  const cases = [
    [{ networkError: 'fetch failed' }, false, 'UNREACHABLE'],
    [{ status: 404, body: 'Not Found' }, false, 'NOT_DEPLOYED'],
    [{ status: 200, body: 'success' }, false, 'ACCEPTS_UNSIGNED'],
    [{ status: 400, body: 'rejected' }, true, 'REACHABLE_AND_REJECTING'],
    [{ status: 500, body: 'error' }, false, 'SERVER_ERROR'],
    [{ status: 401, body: 'Unauthorized' }, false, 'UNEXPECTED'],
    // A 302 to a login page is reachable but wrong — it must not read as a pass.
    [{ status: 302, body: '' }, false, 'UNEXPECTED'],
  ];
  for (const [input, pass, code] of cases) {
    const got = classify(input);
    if (got.pass !== pass || got.code !== code) {
      console.error(
        `FAIL ${JSON.stringify(input)} → ${got.code}/${got.pass}, expected ${code}/${pass}`,
      );
      process.exit(1);
    }
  }
  console.log(`self-check OK (${cases.length} cases)`);
}

async function main() {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    return;
  }

  const base =
    process.argv[2] ??
    process.env.GLOBEPAY_PROBE_BASE ??
    'http://localhost:9000';
  const url = new URL(HOOK_PATH, base).toString();
  console.log(`probing ${url}`);

  // Two shapes of unverifiable body: an empty envelope (fails the presence
  // check) and a well-formed-looking one (fails the RSA verify). Both must be
  // refused — the second is the one a replay attacker would actually send.
  const probes = [
    ['empty envelope', {}],
    [
      'garbage Data/Signature',
      {
        TransactionId: 'probe',
        Data: 'bm90LWFlcw==',
        Signature: 'bm9wZQ==',
        Version: 1,
      },
    ],
  ];

  let failed = false;
  for (const [label, payload] of probes) {
    const verdict = await attempt(url, payload);
    console.log(
      `  ${verdict.pass ? 'PASS' : 'FAIL'}  ${label}: ${verdict.code} — ${verdict.detail}`,
    );
    if (!verdict.pass) failed = true;
  }

  console.log(
    failed
      ? '\nVERDICT: the callback URL is NOT proven reachable-and-rejecting. Fix before enabling deposits.'
      : '\nVERDICT: reachable and rejecting unsigned bodies. Still unproven: that GlobePay is configured with this exact URL, and that a genuine signed callback settles.',
  );
  process.exit(failed ? 1 : 0);
}

await main();
