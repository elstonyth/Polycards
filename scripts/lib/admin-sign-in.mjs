// The two-step admin sign-in (#996) for the local QA scripts: the password
// answers with a code challenge, the authenticator code with the admin token.
// QA_ADMIN_TOTP_SECRET is that admin's authenticator secret (seed:e2e prints
// it as totp_secret=…). There is deliberately no way to skip the code step.
// Same flow as scripts/qa-free-pack.mjs and tests/e2e/helpers/admin.ts.
// Node strips the types (Node 24); the backend's own code math, no dependency.
import { totpCode } from '../../backend/packages/api/src/utils/totp-code.ts';

const SECRET = process.env.QA_ADMIN_TOTP_SECRET;
const STEP_MS = 30_000;
// The pages a signed-out operator lands on.
const SIGN_IN_PAGES = /\/(login|sign-in|two-step-setup)(\/|$)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exits before the script sends anything when the secret is missing. */
export function requireAdminTotp(email) {
  if (SECRET) return;
  console.error(
    `Set QA_ADMIN_TOTP_SECRET to the authenticator secret of ${email ?? 'the admin'}: every admin sign-in asks for its code since #996 (seed:e2e prints it as totp_secret=…).`,
  );
  process.exit(1);
}

// The backend takes each code once per login, so a second sign-in in the same
// 30 s step (dashboard, then API) waits for the next step's code.
let lastStep = -1;
async function freshCode() {
  requireAdminTotp();
  while (Math.floor(Date.now() / STEP_MS) <= lastStep) await sleep(1_000);
  const now = Date.now();
  lastStep = Math.floor(now / STEP_MS);
  return totpCode(SECRET, now);
}

// Sign-ins are rate-limited: a 429 is waited out a few times.
async function post(url, body, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 5) {
      await sleep((Number(text.match(/again in (\d+)s/)?.[1] ?? 8) + 1) * 1000);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${res.status} non-JSON: ${text.slice(0, 200)}`);
    }
  }
}

async function signIn(api, email, password) {
  requireAdminTotp(email);
  // A code another process (e.g. the Playwright suite) just used is retried
  // with the next step's.
  for (let attempt = 0; attempt < 2; attempt++) {
    const login = await post(`${api}/auth/user/emailpass`, { email, password });
    if (!login.mfa_required || !login.mfa_challenge?.id) {
      throw new Error(
        `admin sign-in for ${email} failed: ${login.message ?? 'no code challenge (does this admin have an authenticator set up?)'}`,
      );
    }
    const verified = await post(
      `${api}/auth/mfa/challenges/${login.mfa_challenge.id}/verify`,
      { method: 'totp', code: await freshCode() },
      { Authorization: `Bearer ${login.token}` },
    );
    if (verified.token) return verified.token;
    if (!/just used/i.test(verified.message ?? '')) {
      throw new Error(
        `admin code for ${email} refused: ${verified.message ?? 'no token'} (is QA_ADMIN_TOTP_SECRET this admin's?)`,
      );
    }
  }
  throw new Error(`admin code for ${email} refused twice as just used`);
}

let token;
/** An admin API token, minted once per process (sign-ins are rate-limited). */
export function adminToken(api, email, password) {
  return (token ??= signIn(api, email, password));
}

/** Signs the admin dashboard in on `page`: password, then the code. */
export async function adminUiLogin(page, adminBase, email, password) {
  requireAdminTotp(email);
  // Rate limits and once-per-login codes: a failed try waits and goes again.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(`${adminBase}/sign-in`, { waitUntil: 'domcontentloaded' });
    await page.locator('#sign-in-email').fill(email);
    await page.locator('#sign-in-password').fill(password);
    await page.keyboard.press('Enter');
    try {
      const code = page.locator('#two-step-code');
      await code.waitFor({ timeout: 12_000 });
      await code.fill(await freshCode());
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => !SIGN_IN_PAGES.test(u.pathname), {
        timeout: 12_000,
      });
      return;
    } catch {
      if (page.url().includes('two-step-setup')) {
        throw new Error(
          `${email} has no authenticator set up (seed:e2e sets one up and prints totp_secret=…)`,
        );
      }
      await sleep(8_000);
    }
  }
  throw new Error(
    `admin sign-in for ${email} never got past the code step (wrong password or QA_ADMIN_TOTP_SECRET, or rate-limited?)`,
  );
}
