// scripts/qa-phase5.mjs — Visual QA for VIP Phase 5 pages.
// Captures full-page screenshots of wallet, vip, referrals, notifications, and /invite/:handle.
// Attempts to auth as the test customer first; falls back to logged-out captures if backend is
// unavailable (redirects to home still prove no crash/error overlay).
//
// Usage: node scripts/qa-phase5.mjs
// Requires :4000 to be serving the standalone build.
// Backend at :9000 is optional — fallback mode documents the gap in output.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.QA_BASE ?? 'http://localhost:4000';
const BACKEND = process.env.QA_BACKEND ?? 'http://localhost:9000';
const EMAIL = 'test@pokenic.app';
const PASSWORD = 'PokenicTest123!';
const AUTH_COOKIE = '_pokenic_jwt';

const TOKEN_PAGES = ['/wallet', '/vip', '/referrals', '/notifications'];
const PUBLIC_PAGES = ['/invite/test'];

const OUT_DIR = path.resolve('docs/research');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const slug = (p) => p.replace(/\//g, '_');

/** Try to obtain a JWT from the backend. Returns null if backend is unreachable. */
async function tryGetJwt() {
  try {
    const res = await fetch(`${BACKEND}/auth/customer/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(
        `[auth] backend returned ${res.status} — will capture logged-out state`,
      );
      return null;
    }
    const data = await res.json();
    const token = data.token ?? data.access_token ?? data.jwt;
    if (!token) {
      console.warn(
        '[auth] no token in response — will capture logged-out state',
      );
      return null;
    }
    console.log('[auth] got JWT from backend');
    return token;
  } catch (err) {
    console.warn(
      `[auth] backend unreachable (${err.message}) — will capture logged-out state`,
    );
    return null;
  }
}

const jwt = await tryGetJwt();
const backendUp = jwt !== null;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});

if (jwt) {
  await ctx.addCookies([
    {
      name: AUTH_COOKIE,
      value: jwt,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  console.log(`[auth] cookie '${AUTH_COOKIE}' planted`);
} else {
  console.log('[auth] skipping cookie — capturing pages in logged-out state');
}

const page = await ctx.newPage();
const results = [];

for (const p of [...TOKEN_PAGES, ...PUBLIC_PAGES]) {
  const outPath = path.join(OUT_DIR, `phase5${slug(p)}.png`);
  try {
    await page.goto(`${BASE}${p}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.screenshot({ path: outPath, fullPage: true });
    const url = page.url();
    const redirected = !url.includes(p.replace('/invite/test', '/invite/'));
    results.push({ page: p, status: 'ok', redirected, outPath });
    console.log(
      `[shot] ${p} → ${outPath}${redirected ? ` (redirected → ${url})` : ''}`,
    );
  } catch (err) {
    try {
      await page.screenshot({ path: outPath, fullPage: true });
    } catch (_) {
      // ignore secondary failure
    }
    results.push({ page: p, status: 'error', error: err.message, outPath });
    console.error(`[shot] ${p} ERROR: ${err.message}`);
  }
}

await browser.close();

console.log('\n=== QA Phase 5 Summary ===');
console.log(`Backend up: ${backendUp}`);
for (const r of results) {
  const tag = r.status === 'ok' ? (r.redirected ? 'REDIRECT' : 'OK') : 'ERROR';
  console.log(`  ${tag.padEnd(8)} ${r.page}`);
}
console.log('===========================\n');

// Exit non-zero only on hard errors (not redirects — redirects are expected when backend is down)
const hardErrors = results.filter((r) => r.status === 'error');
if (hardErrors.length) {
  console.error(`${hardErrors.length} page(s) failed to capture`);
  process.exit(1);
}
