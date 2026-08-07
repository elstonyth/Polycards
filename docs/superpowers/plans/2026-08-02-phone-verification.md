# Phone Verification (SMS OTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SMS OTP verification for the three phone flows — account creation, phone-number change, and forgot-password-by-phone — enforced server-side, with a dev/test mode that needs no SMS provider.

**Architecture:** Twilio Verify v2 (managed OTP — Twilio stores/expires the codes, we never persist one) called via plain `fetch` from the Medusa backend. A successful code check mints a short-lived HMAC **proof token** (stateless — no DB migration anywhere in this plan). The proof token is the credential each flow presents: signup carries it in a header past a new middleware gate on `POST /store/customers`; phone change and password-reset exchange it at new custom store routes. Everything is behind `PHONE_VERIFICATION_REQUIRED` (default **off**, so dev/CI/e2e stay green) and mirrors the existing Resend pattern: one shared "is configured" predicate, dev/test uses a logged fixed code instead of live SMS.

**Tech Stack:** Medusa v2 custom store routes + `defineMiddlewares` guards (backend `packages/api`), node `crypto` HMAC (no new deps), Twilio Verify v2 REST API (no SDK dep), Next.js server actions + client components (storefront), existing env-tunable sliding-window rate limiters.

## Global Constraints

- **No new npm dependencies.** Twilio via `fetch`; proof tokens via node `crypto`. Backend must not gain `libphonenumber-js` — it re-validates phones with an E.164 regex only (the storefront already normalizes with libphonenumber before sending).
- **No DB migration.** Verified-ness is enforced at the write gates, not stored. If every phone write requires a proof token, `customer.phone` is verified by construction. (Legacy phones written before enforcement are unverified — accepted, see Task 5 notes.)
- **Env vars (backend):** `PHONE_VERIFICATION_REQUIRED` (`'true'` = enforce; anything else = off), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `PHONE_OTP_DEV_CODE` (dev/test fixed code, default `000000`), `PHONE_OTP_START_RATE_*` / `PHONE_OTP_CHECK_RATE_*` (limiter tuning, see Task 2).
- **Env vars (storefront):** `NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED` (`'true'` shows the OTP steps). Must match the backend flag; drift is UX-only (backend enforcement is authoritative) — a skipped OTP step surfaces as a clear 400, an extra OTP step is harmless.
- **Dev/test NEVER sends live SMS** — same rule as the password-reset subscriber: `NODE_ENV === 'development' || 'test'` short-circuits to the logged dev code *before* checking Twilio config, so real credentials in a dev `.env` can't send SMS from a dev box.
- **Fail closed in prod:** enforcement on + Twilio unconfigured → the start route 503s loudly. Never silently skip verification.
- **Repo traps** (from project memory — real, not hypothetical): a global prettier hook may churn backend `.ts` quote style on Edit/Write — if diffs come back with whole-file quote churn, write backend files via a node script through Bash instead. `guard-secrets` blocks `.env.example` edits — document env vars in this plan and `CONTEXT.md`, not `.env.example`. Never add `**SECRET**` placeholders to the DO app spec before the key exists (`do-apply.ps1` aborts on any unresolved token) — prod env vars go in at deploy time with real values (Task 9).
- **Style:** TypeScript strict, no `any`; backend uses single quotes; comments explain constraints, not narration.
- **Verification commands:** backend unit specs run from `backend/packages/api` with `corepack yarn jest <path> --config jest.config.js` (match the invocation of the sibling spec you copied); http specs need `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http`. Storefront: `npm run check` from the repo root. The Stop hook re-typechecks both — a red build cannot slip through.
- **Conventional commits.** One commit per task minimum.

## File Structure

| File | Responsibility |
|---|---|
| `backend/packages/api/src/utils/phone-verification.ts` (create) | Predicates, E.164 regex, purposes, proof-token sign/verify, Twilio Verify client, dev-code transport |
| `backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts` (create) | Unit spec for the above |
| `backend/packages/api/src/api/utils/phone-verification-guard.ts` (create) | Middlewares: signup proof gate + direct-phone-write block |
| `backend/packages/api/src/api/utils/__tests__/phone-verification-guard.unit.spec.ts` (create) | Unit spec for the guards |
| `backend/packages/api/src/api/store/phone-verification/start/route.ts` (create) | `POST` — send OTP (or log dev code) |
| `backend/packages/api/src/api/store/phone-verification/check/route.ts` (create) | `POST` — check code → mint proof token |
| `backend/packages/api/src/api/store/phone-verification/change/route.ts` (create) | `POST` (authed) — proof-gated phone update |
| `backend/packages/api/src/api/store/phone-verification/password-reset/route.ts` (create) | `POST` — proof → core reset token |
| `backend/packages/api/src/api/utils/rate-limit.ts` (modify) | Two new limiter factories |
| `backend/packages/api/src/api/middlewares.ts` (modify) | Route entries for all of the above |
| backend http spec `integration-tests` dir, `phone-verification.spec.ts` (create — put it beside the existing http specs; find them with `Glob backend/packages/api/**/*.spec.ts` filtered to the integration-tests folder) | Full-loop spec in dev-code mode |
| `src/lib/phone-verification.ts` (create) | Storefront flag + purpose type |
| `src/lib/actions/phone-verification.ts` (create) | Server actions: start / check / changePhone / resetPasswordByPhone |
| `src/components/auth/PhoneOtpStep.tsx` (create) | Reusable code-entry step (input, resend w/ cooldown, error note) |
| `src/lib/actions/auth.ts` (modify) | `signup` accepts + forwards the proof token |
| `src/components/AuthForm.tsx` (modify) | Signup OTP step; forgot-password phone path |
| `src/lib/actions/customer.ts` (modify) | `updateProfile` stops sending `phone` when enforcement is on |
| `src/components/account/SettingsForm.tsx` (modify) | Read-only phone + verified "Change" flow when enforcement is on |
| `src/app/reset-password/**` (verify/modify) | Page must work with `token` alone (email param optional) |

---

### Task 1: Backend phone-verification util (predicates, proof token, Twilio client)

**Files:**
- Create: `backend/packages/api/src/utils/phone-verification.ts`
- Test: `backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts`

**Interfaces:**
- Consumes: nothing (leaf util).
- Produces (used by Tasks 2–5):
  - `isPhoneVerificationRequired(env: PhoneVerificationEnv): boolean`
  - `isTwilioVerifyConfigured(env: PhoneVerificationEnv): boolean`
  - `E164_RE: RegExp`
  - `PHONE_OTP_PURPOSES` / `type PhoneOtpPurpose = 'signup' | 'phone-change' | 'password-reset'` / `isPhoneOtpPurpose(v: unknown): v is PhoneOtpPurpose`
  - `signPhoneProof(secret: string, phone: string, purpose: PhoneOtpPurpose, nowMs?: number): string`
  - `verifyPhoneProof(secret: string, token: string, purpose: PhoneOtpPurpose, nowMs?: number): { phone: string } | null`
  - `sendPhoneOtp(env: PhoneVerificationEnv, logger: Logger, phone: string): Promise<void>` (throws `MedusaError` when unavailable/failed)
  - `checkPhoneOtpCode(env: PhoneVerificationEnv, logger: Logger, phone: string, code: string): Promise<boolean>`

- [ ] **Step 1: Write the failing unit spec**

Copy the header conventions of an existing unit spec (e.g. `src/modules/resend/__tests__/service.unit.spec.ts`) — same jest setup, no test runner boot. Spec content:

```typescript
import {
  E164_RE,
  isPhoneOtpPurpose,
  isPhoneVerificationRequired,
  isTwilioVerifyConfigured,
  signPhoneProof,
  verifyPhoneProof,
  sendPhoneOtp,
  checkPhoneOtpCode,
} from '../phone-verification';

const SECRET = 'test-secret';
const PHONE = '+60107667787';
const noopLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as never;

describe('predicates', () => {
  it('requires the literal string true', () => {
    expect(isPhoneVerificationRequired({ PHONE_VERIFICATION_REQUIRED: 'true' })).toBe(true);
    expect(isPhoneVerificationRequired({ PHONE_VERIFICATION_REQUIRED: '1' })).toBe(false);
    expect(isPhoneVerificationRequired({})).toBe(false);
  });
  it('twilio needs all three vars', () => {
    const full = {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_VERIFY_SERVICE_SID: 'VA1',
    };
    expect(isTwilioVerifyConfigured(full)).toBe(true);
    expect(isTwilioVerifyConfigured({ ...full, TWILIO_AUTH_TOKEN: '' })).toBe(false);
  });
  it('E164_RE accepts +60/+44 shapes, rejects garbage', () => {
    expect(E164_RE.test('+60107667787')).toBe(true);
    expect(E164_RE.test('+442079460958')).toBe(true);
    expect(E164_RE.test('0107667787')).toBe(false);
    expect(E164_RE.test('+0123')).toBe(false);
  });
  it('purpose guard', () => {
    expect(isPhoneOtpPurpose('signup')).toBe(true);
    expect(isPhoneOtpPurpose('admin')).toBe(false);
  });
});

describe('proof token', () => {
  it('round-trips phone + purpose', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof(SECRET, token, 'signup')).toEqual({ phone: PHONE });
  });
  it('rejects wrong purpose', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof(SECRET, token, 'phone-change')).toBeNull();
  });
  it('rejects wrong secret and tampered payload', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof('other', token, 'signup')).toBeNull();
    const [payload, sig] = token.split('.');
    const forged =
      Buffer.from(JSON.stringify({ phone: '+15550001111', purpose: 'signup', exp: Date.now() + 60_000 })).toString('base64url') +
      '.' + sig;
    expect(verifyPhoneProof(SECRET, forged, 'signup')).toBeNull();
    expect(verifyPhoneProof(SECRET, payload, 'signup')).toBeNull(); // missing sig segment
  });
  it('rejects an expired token', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup', 1_000);
    expect(verifyPhoneProof(SECRET, token, 'signup', 1_000 + 11 * 60_000)).toBeNull();
  });
});

describe('dev-code transport (NODE_ENV=test)', () => {
  // jest runs with NODE_ENV=test, so the dev/test branch is the live one here.
  it('send logs instead of calling twilio', async () => {
    const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as never;
    await sendPhoneOtp({}, logger, PHONE);
    expect((logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining(PHONE),
    );
  });
  it('check accepts the dev code, rejects others', async () => {
    await expect(checkPhoneOtpCode({}, noopLogger, PHONE, '000000')).resolves.toBe(true);
    await expect(checkPhoneOtpCode({ PHONE_OTP_DEV_CODE: '424242' }, noopLogger, PHONE, '424242')).resolves.toBe(true);
    await expect(checkPhoneOtpCode({}, noopLogger, PHONE, '111111')).resolves.toBe(false);
  });
});

describe('twilio transport', () => {
  const env = {
    NODE_ENV: 'production',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_VERIFY_SERVICE_SID: 'VA1',
  };
  afterEach(() => jest.restoreAllMocks());

  it('send posts To/Channel with basic auth', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'pending' }), { status: 201 }));
    await sendPhoneOtp(env, noopLogger, PHONE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://verify.twilio.com/v2/Services/VA1/Verifications');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('AC1:tok').toString('base64'),
    );
    expect(String(init?.body)).toContain('Channel=sms');
  });
  it('check maps approved → true, anything else → false', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'approved' }), { status: 200 }));
    await expect(checkPhoneOtpCode(env, noopLogger, PHONE, '123456')).resolves.toBe(true);
    jest.restoreAllMocks();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }));
    await expect(checkPhoneOtpCode(env, noopLogger, PHONE, '123456')).resolves.toBe(false);
  });
  it('send throws MedusaError when unconfigured in prod', async () => {
    await expect(sendPhoneOtp({ NODE_ENV: 'production' }, noopLogger, PHONE)).rejects.toThrow(
      /not configured/i,
    );
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `corepack yarn jest src/utils/__tests__/phone-verification.unit.spec.ts` from `backend/packages/api`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
import { createHmac, timingSafeEqual } from 'crypto';
import { MedusaError } from '@medusajs/framework/utils';

// SMS OTP for the three phone flows (signup / phone-change / password-reset).
// Twilio Verify holds the codes — nothing OTP-shaped is ever persisted here.
// A passed check mints a short-lived HMAC "proof token" that the write gates
// (see api/utils/phone-verification-guard.ts and the phone-verification
// routes) accept as evidence of phone possession. Stateless by design: no
// table, no migration; replay inside the 10m TTL only lets the same PROVEN
// phone be used again, which every consumer tolerates.
//
// Mirrors modules/resend/options.ts: one env predicate shared by everything
// that gates on configuration, and dev/test NEVER touches the live transport
// (the logged dev code IS the local SMS transport, checked BEFORE Twilio
// config so real credentials in a dev .env can't send SMS from a dev box).

export type PhoneVerificationEnv = {
  NODE_ENV?: string;
  PHONE_VERIFICATION_REQUIRED?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  PHONE_OTP_DEV_CODE?: string;
};

type Logger = { warn: (msg: string) => void };

export const isPhoneVerificationRequired = (env: PhoneVerificationEnv): boolean =>
  env.PHONE_VERIFICATION_REQUIRED === 'true';

export const isTwilioVerifyConfigured = (env: PhoneVerificationEnv): boolean =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);

/** E.164: +, non-zero lead digit, 7–15 digits total. The storefront normalizes
 *  with libphonenumber before sending; this is the backend's shape re-check. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

export const PHONE_OTP_PURPOSES = ['signup', 'phone-change', 'password-reset'] as const;
export type PhoneOtpPurpose = (typeof PHONE_OTP_PURPOSES)[number];
export const isPhoneOtpPurpose = (v: unknown): v is PhoneOtpPurpose =>
  typeof v === 'string' && (PHONE_OTP_PURPOSES as readonly string[]).includes(v);

/** ponytail: 10m fixed TTL, no config knob — add one only if support tickets ask. */
const PROOF_TTL_MS = 10 * 60_000;

type ProofPayload = { phone: string; purpose: PhoneOtpPurpose; exp: number };

export function signPhoneProof(
  secret: string,
  phone: string,
  purpose: PhoneOtpPurpose,
  nowMs: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ phone, purpose, exp: nowMs + PROOF_TTL_MS } satisfies ProofPayload),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPhoneProof(
  secret: string,
  token: string,
  purpose: PhoneOtpPurpose,
  nowMs: number = Date.now(),
): { phone: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: ProofPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ProofPayload;
  } catch {
    return null;
  }
  if (parsed.purpose !== purpose) return null;
  if (typeof parsed.exp !== 'number' || parsed.exp <= nowMs) return null;
  if (typeof parsed.phone !== 'string' || !E164_RE.test(parsed.phone)) return null;
  return { phone: parsed.phone };
}

const isDevOrTest = (env: PhoneVerificationEnv): boolean =>
  env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

const devCode = (env: PhoneVerificationEnv): string => env.PHONE_OTP_DEV_CODE || '000000';

const twilioBase = (env: PhoneVerificationEnv): string =>
  `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}`;

const twilioHeaders = (env: PhoneVerificationEnv): Record<string, string> => ({
  Authorization:
    'Basic ' +
    Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
  'Content-Type': 'application/x-www-form-urlencoded',
});

/** Sends the OTP. Dev/test: logs the fixed dev code (the log is the SMS
 *  transport). Prod without Twilio: throws — enforcement on + unconfigured
 *  must brick LOUDLY, never silently skip verification. */
export async function sendPhoneOtp(
  env: PhoneVerificationEnv,
  logger: Logger,
  phone: string,
): Promise<void> {
  if (isDevOrTest(env)) {
    logger.warn(`[phone-otp] dev transport — code for ${phone} is ${devCode(env)}`);
    return;
  }
  if (!isTwilioVerifyConfigured(env)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Phone verification is not configured.',
    );
  }
  const res = await fetch(`${twilioBase(env)}/Verifications`, {
    method: 'POST',
    headers: twilioHeaders(env),
    body: new URLSearchParams({ To: phone, Channel: 'sms' }).toString(),
  });
  if (!res.ok) {
    // Twilio 429s (per-number caps, Fraud Guard) land here too — surface a
    // retryable message, log the status only (never the body: it echoes To=).
    logger.warn(`[phone-otp] twilio send failed with ${res.status}`);
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not send the verification code. Try again shortly.',
    );
  }
}

/** True iff the code is approved for this phone. Never throws on a wrong
 *  code — only on transport-level failure. */
export async function checkPhoneOtpCode(
  env: PhoneVerificationEnv,
  logger: Logger,
  phone: string,
  code: string,
): Promise<boolean> {
  if (isDevOrTest(env)) return code === devCode(env);
  if (!isTwilioVerifyConfigured(env)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Phone verification is not configured.',
    );
  }
  const res = await fetch(`${twilioBase(env)}/VerificationCheck`, {
    method: 'POST',
    headers: twilioHeaders(env),
    body: new URLSearchParams({ To: phone, Code: code }).toString(),
  });
  // Twilio 404s a check whose verification already expired/was consumed —
  // that's a plain "wrong/expired code" to us, not a transport failure.
  if (res.status === 404) return false;
  if (!res.ok) {
    logger.warn(`[phone-otp] twilio check failed with ${res.status}`);
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not verify the code. Try again shortly.',
    );
  }
  const body = (await res.json()) as { status?: string };
  return body.status === 'approved';
}
```

- [ ] **Step 4: Run the spec, verify PASS.** Same command as Step 2.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/utils/phone-verification.ts backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts
git commit -m "feat(phone): OTP util — predicates, HMAC proof token, Twilio Verify client, dev-code transport"
```

---

### Task 2: OTP start/check routes + rate limiters + middleware entries

**Files:**
- Create: `backend/packages/api/src/api/store/phone-verification/start/route.ts`
- Create: `backend/packages/api/src/api/store/phone-verification/check/route.ts`
- Modify: `backend/packages/api/src/api/utils/rate-limit.ts` (append two factories)
- Modify: `backend/packages/api/src/api/middlewares.ts` (two entries)
- Test: http spec `phone-verification.spec.ts` beside the existing integration-http specs (locate the folder with Glob; copy a neighboring spec's `medusaIntegrationTestRunner` boilerplate exactly)

**Interfaces:**
- Consumes (Task 1): `sendPhoneOtp`, `checkPhoneOtpCode`, `signPhoneProof`, `E164_RE`, `isPhoneOtpPurpose`, `isPhoneVerificationRequired`, `PhoneOtpPurpose`.
- Produces:
  - `POST /store/phone-verification/start` body `{ phone: string, purpose: PhoneOtpPurpose }` → `200 { ok: true }` (always generic), `400` bad input, `429` limited.
  - `POST /store/phone-verification/check` body `{ phone, purpose, code: string }` → `200 { token: string }` or `400 { message: 'Invalid or expired code.' }`.
  - `createPhoneOtpStartRateLimit()` / `createPhoneOtpCheckRateLimit()` in rate-limit.ts.
  - The jwt-secret resolution idiom used by Tasks 3–5: `req.scope.resolve('configModule').projectConfig.http.jwtSecret`.

- [ ] **Step 1: Write the failing http spec** (dev-code mode — the test runner sets `NODE_ENV=test`, so no Twilio calls; the dev code is `000000`):

```typescript
// Copy the runner boilerplate (medusaIntegrationTestRunner, publishable-key
// header helper, seeding) from the neighboring http spec — conventions matter
// more than this sketch. Assertions to keep:

describe('POST /store/phone-verification/start', () => {
  it('202-oks a valid E.164 + purpose', async () => {
    const res = await api.post('/store/phone-verification/start', {
      phone: '+60107667787', purpose: 'signup',
    }, headers);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });
  it('400s a non-E.164 phone and an unknown purpose', async () => {
    await expect(api.post('...', { phone: '0107667787', purpose: 'signup' }, headers))
      .rejects.toMatchObject({ response: { status: 400 } });
    await expect(api.post('...', { phone: '+60107667787', purpose: 'admin' }, headers))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
});

describe('POST /store/phone-verification/check', () => {
  it('mints a proof token for the dev code', async () => {
    const res = await api.post('/store/phone-verification/check', {
      phone: '+60107667787', purpose: 'signup', code: '000000',
    }, headers);
    expect(res.status).toBe(200);
    expect(typeof res.data.token).toBe('string');
    expect(res.data.token).toContain('.');
  });
  it('400s a wrong code with a generic message', async () => {
    await expect(api.post('...', { phone: '+60107667787', purpose: 'signup', code: '111111' }, headers))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (404 — routes don't exist): from `backend/packages/api`, `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest phone-verification` (match the exact jest invocation the repo's CI uses for the neighboring spec; needs `pokenic-postgres` up, and a fresh worktree needs `corepack yarn build` in `packages/odds-math` first — see memory).

- [ ] **Step 3: Implement `start/route.ts`**

```typescript
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import {
  E164_RE,
  isPhoneOtpPurpose,
  sendPhoneOtp,
} from '../../../../utils/phone-verification';

// Public: sends (or dev-logs) an OTP for one of the three phone flows. The
// response is ALWAYS the generic { ok: true } — whether the phone belongs to
// an account is never disclosed here. SMS-pumping protection is layered:
// the phone-otp-start IP limiter (middlewares.ts), Twilio Verify's own
// per-number caps, and — for password-reset — no SMS at all unless exactly
// one registered account carries the phone (a pumping run would otherwise
// use the reset flow to text arbitrary numbers on our bill).
type Body = { phone?: unknown; purpose?: unknown };

export async function POST(req: MedusaRequest<Body>, res: MedusaResponse): Promise<void> {
  const { phone, purpose } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');
  if (!isPhoneOtpPurpose(purpose))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid purpose.');

  const logger = req.scope.resolve('logger');

  if (purpose === 'password-reset') {
    const customerService: ICustomerModuleService = req.scope.resolve(Modules.CUSTOMER);
    const matches = await customerService.listCustomers(
      { phone, has_account: true },
      { select: ['id'], take: 2 },
    );
    if (matches.length !== 1) {
      // Zero matches: don't text strangers. Two+: ambiguous, the check step
      // would refuse anyway. Same 200 either way — no oracle. Timing skew vs
      // the Twilio call exists; accepted (the email flow has the same shape:
      // core 201s unknown emails without sending).
      res.json({ ok: true });
      return;
    }
  }

  await sendPhoneOtp(process.env, logger, phone);
  res.json({ ok: true });
}
```

- [ ] **Step 4: Implement `check/route.ts`**

```typescript
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  E164_RE,
  checkPhoneOtpCode,
  isPhoneOtpPurpose,
  signPhoneProof,
} from '../../../../utils/phone-verification';

// Public: exchanges a correct OTP for a 10m proof token. The token is the
// only artifact downstream gates trust — the code itself never travels
// further than this route.
type Body = { phone?: unknown; purpose?: unknown; code?: unknown };

export async function POST(req: MedusaRequest<Body>, res: MedusaResponse): Promise<void> {
  const { phone, purpose, code } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');
  if (!isPhoneOtpPurpose(purpose))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid purpose.');
  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid or expired code.');

  const logger = req.scope.resolve('logger');
  const approved = await checkPhoneOtpCode(process.env, logger, phone, code);
  if (!approved)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid or expired code.');

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  if (!jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  res.json({ token: signPhoneProof(jwtSecret, phone, purpose) });
}
```

Verify the `configModule` resolution idiom against an existing consumer in this repo (grep `configModule` under `backend/packages/api/src`) — if the repo resolves it differently (e.g. `ContainerRegistrationKeys.CONFIG_MODULE`), use that form here and in Tasks 3–5.

- [ ] **Step 5: Append the two limiter factories to `rate-limit.ts`** (after `createAuthRateLimit`, same doc-comment style):

```typescript
/**
 * The phone-OTP send limiter (POST /store/phone-verification/start). PUBLIC
 * route — keys on the request IP. Each allowed request can cost real money
 * (one SMS), so this is the tightest budget in the file: SMS-pumping
 * protection, layered under Twilio Verify's own per-number caps. Env-tunable:
 * PHONE_OTP_START_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 3/60s)
 * PHONE_OTP_START_RATE_LIMIT / _WINDOW_MS (default 10/1h)
 */
export function createPhoneOtpStartRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'phone-otp-start',
    message: 'Too many code requests.',
    defaults: { burstLimit: 3, burstWindowMs: 60_000, limit: 10, windowMs: 3_600_000 },
  });
}

/**
 * The phone-OTP check limiter (POST /store/phone-verification/check). PUBLIC —
 * keys on IP. Bounds code guessing from one address; Twilio additionally caps
 * 5 checks per verification. Env-tunable:
 * PHONE_OTP_CHECK_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 5/60s)
 * PHONE_OTP_CHECK_RATE_LIMIT / _WINDOW_MS (default 20/1h)
 */
export function createPhoneOtpCheckRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'phone-otp-check',
    message: 'Too many verification attempts.',
    defaults: { burstLimit: 5, burstWindowMs: 60_000, limit: 20, windowMs: 3_600_000 },
  });
}
```

- [ ] **Step 6: Register in `middlewares.ts`** — import the two factories, add entries next to the auth-limiter entries (public routes, so no `authenticate`; keep the comment discipline of the file):

```typescript
{
  // OTP send — public, IP-keyed, tightest budget in the file (each allowed
  // request can cost one SMS). See createPhoneOtpStartRateLimit.
  matcher: '/store/phone-verification/start',
  method: 'POST',
  middlewares: [createPhoneOtpStartRateLimit()],
},
{
  // OTP check — public, IP-keyed; bounds code guessing (Twilio also caps 5
  // checks per verification server-side).
  matcher: '/store/phone-verification/check',
  method: 'POST',
  middlewares: [createPhoneOtpCheckRateLimit()],
},
```

- [ ] **Step 7: Run the http spec, verify PASS.** Also re-run the middleware coverage/regression unit specs (`npx jest src/api/__tests__`) — if a store-route coverage guard exists and flags the new matchers, add them to its expected list with a one-line reason.

- [ ] **Step 8: Commit**

```bash
git add backend/packages/api/src/api/store/phone-verification backend/packages/api/src/api/utils/rate-limit.ts backend/packages/api/src/api/middlewares.ts <http-spec-path>
git commit -m "feat(phone): OTP start/check store routes with IP rate limits"
```

---

### Task 3: Enforcement gates — signup proof + direct phone-write block

**Files:**
- Create: `backend/packages/api/src/api/utils/phone-verification-guard.ts`
- Test: `backend/packages/api/src/api/utils/__tests__/phone-verification-guard.unit.spec.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (extend the two existing `/store/customers` entries)
- Modify: http spec from Task 2 (add the gated-signup loop)

**Interfaces:**
- Consumes (Task 1): `isPhoneVerificationRequired`, `verifyPhoneProof`.
- Produces:
  - `requireSignupPhoneProof` — middleware for `POST /store/customers`: when enforcement is on and `body.phone` is a string, requires header `x-phone-verification` to verify as a `'signup'` proof whose phone equals `body.phone`; otherwise `next()`.
  - `blockUnverifiedPhoneWrite` — middleware for `POST /store/customers/me`: when enforcement is on, rejects a **string** `body.phone` (clears via `null` stay allowed; changes must go through Task 4's route).
  - Header name contract for the storefront (Task 6): `x-phone-verification`.

- [ ] **Step 1: Write the failing unit spec.** Model it on the existing guard specs (e.g. the customer-metadata-guard or disabled-guard spec — find with Glob and copy the req/res/next mocking style). Cases:

```typescript
import { requireSignupPhoneProof, blockUnverifiedPhoneWrite } from '../phone-verification-guard';
import { signPhoneProof } from '../../../utils/phone-verification';

const SECRET = 'test-secret';
const PHONE = '+60107667787';

// Build a minimal MedusaRequest stand-in: body, headers, and a scope whose
// configModule carries jwtSecret (copy the container-mock idiom from the
// sibling guard spec).
const makeReq = (body: unknown, headers: Record<string, string> = {}) => ({
  body,
  headers,
  scope: {
    resolve: (key: string) =>
      key === 'configModule'
        ? { projectConfig: { http: { jwtSecret: SECRET } } }
        : undefined,
  },
}) as never;

describe('requireSignupPhoneProof', () => {
  const run = (req: never) =>
    new Promise<unknown>((resolve) => requireSignupPhoneProof(req, {} as never, resolve));

  it('passes untouched when enforcement is off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(makeReq({ phone: PHONE }))).toBeUndefined();
  });

  describe('enforcement on', () => {
    beforeEach(() => { process.env.PHONE_VERIFICATION_REQUIRED = 'true'; });
    afterEach(() => { delete process.env.PHONE_VERIFICATION_REQUIRED; });

    it('passes a phoneless body (Google signup carries no phone)', async () => {
      expect(await run(makeReq({ email: 'a@b.c' }))).toBeUndefined();
    });
    it('passes a valid signup proof for the same phone', async () => {
      const token = signPhoneProof(SECRET, PHONE, 'signup');
      expect(await run(makeReq({ phone: PHONE }, { 'x-phone-verification': token }))).toBeUndefined();
    });
    it('rejects a missing header', async () => {
      expect(await run(makeReq({ phone: PHONE }))).toBeInstanceOf(Error);
    });
    it('rejects a proof for a different phone', async () => {
      const token = signPhoneProof(SECRET, '+15550001111', 'signup');
      expect(await run(makeReq({ phone: PHONE }, { 'x-phone-verification': token }))).toBeInstanceOf(Error);
    });
    it('rejects a wrong-purpose proof', async () => {
      const token = signPhoneProof(SECRET, PHONE, 'phone-change');
      expect(await run(makeReq({ phone: PHONE }, { 'x-phone-verification': token }))).toBeInstanceOf(Error);
    });
  });
});

describe('blockUnverifiedPhoneWrite', () => {
  const run = (req: never) =>
    new Promise<unknown>((resolve) => blockUnverifiedPhoneWrite(req, {} as never, resolve));

  it('passes when enforcement is off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(makeReq({ phone: PHONE }))).toBeUndefined();
  });
  describe('enforcement on', () => {
    beforeEach(() => { process.env.PHONE_VERIFICATION_REQUIRED = 'true'; });
    afterEach(() => { delete process.env.PHONE_VERIFICATION_REQUIRED; });

    it('rejects a string phone', async () => {
      expect(await run(makeReq({ phone: PHONE }))).toBeInstanceOf(Error);
    });
    it('allows clearing (null) and phoneless updates', async () => {
      expect(await run(makeReq({ phone: null }))).toBeUndefined();
      expect(await run(makeReq({ first_name: 'A' }))).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (module not found).

- [ ] **Step 3: Implement the guard**

```typescript
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  isPhoneVerificationRequired,
  verifyPhoneProof,
} from '../../utils/phone-verification';

// The two write gates that make phone verification MANDATORY (everything in
// Task 2 is opt-in plumbing until these exist). Both read the env flag per
// request so the http specs can flip it without rebooting the app.
//
// Scope note: a phoneless direct-API signup already bypasses the storefront's
// "phone required" rule today; these gates keep that scope (they verify the
// phone IF one is written, they don't add a phone-presence requirement).

export const PHONE_VERIFICATION_HEADER = 'x-phone-verification';

const secretOf = (req: MedusaRequest): string => {
  const secret = req.scope.resolve('configModule').projectConfig.http.jwtSecret;
  if (!secret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  return secret;
};

/** POST /store/customers — a signup that writes a phone must prove it. */
export const requireSignupPhoneProof = (
  req: MedusaRequest<{ phone?: unknown }>,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  if (!isPhoneVerificationRequired(process.env)) return next();
  const phone = req.body?.phone;
  if (typeof phone !== 'string') return next(); // Google signup has no phone
  const header = req.headers[PHONE_VERIFICATION_HEADER];
  const token = typeof header === 'string' ? header : '';
  const proof = token ? verifyPhoneProof(secretOf(req), token, 'signup') : null;
  if (!proof || proof.phone !== phone) {
    // next(err) — repo convention for surfacing middleware errors (see
    // blockUnusedVendorSelfRegistration).
    return next(
      new MedusaError(MedusaError.Types.INVALID_DATA, 'Phone verification required.'),
    );
  }
  next();
};

/** POST /store/customers/me — phone CHANGES go through the verified route
 *  (store/phone-verification/change); clearing to null stays allowed. */
export const blockUnverifiedPhoneWrite = (
  req: MedusaRequest<{ phone?: unknown }>,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  if (!isPhoneVerificationRequired(process.env)) return next();
  if (typeof req.body?.phone === 'string') {
    return next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Phone changes require verification.',
      ),
    );
  }
  next();
};
```

- [ ] **Step 4: Wire into `middlewares.ts`** — extend the two existing entries (order after the metadata guard):

```typescript
{
  matcher: '/store/customers',
  method: 'POST',
  middlewares: [rejectCustomerMetadata, requireSignupPhoneProof],
},
{
  matcher: '/store/customers/me',
  method: 'POST',
  middlewares: [rejectCustomerMetadata, blockUnverifiedPhoneWrite],
},
```

- [ ] **Step 5: Extend the Task-2 http spec** with the full gated loop (set `process.env.PHONE_VERIFICATION_REQUIRED = 'true'` in a `describe`-scoped `beforeAll`, delete in `afterAll` — the guards read env per request):

```typescript
describe('gated signup', () => {
  it('refuses registration with a phone but no proof', async () => {
    // register-token dance copied from the existing auth http spec:
    // POST /auth/customer/emailpass/register → token, then
    // POST /store/customers { email, phone } with Bearer → expect 400.
  });
  it('accepts registration with a fresh signup proof header', async () => {
    // start → check (dev code) → token → POST /store/customers with
    // x-phone-verification: token → expect 200 and customer.phone persisted.
  });
  it('refuses a direct phone change on /store/customers/me', async () => {
    // login → POST /store/customers/me { phone: '+60...' } → expect 400.
  });
});
```

- [ ] **Step 6: Run unit + http specs, verify PASS.**

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/api/utils/phone-verification-guard.ts backend/packages/api/src/api/utils/__tests__/phone-verification-guard.unit.spec.ts backend/packages/api/src/api/middlewares.ts <http-spec-path>
git commit -m "feat(phone): enforce signup proof and block direct phone writes behind PHONE_VERIFICATION_REQUIRED"
```

---

### Task 4: Verified phone-change route

**Files:**
- Create: `backend/packages/api/src/api/store/phone-verification/change/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (one entry)
- Test: extend the Task-2 http spec

**Interfaces:**
- Consumes: Task 1 (`verifyPhoneProof`, `E164_RE`), Task 3's header/secret idiom, `deliveryWriteRateLimit` (existing shared write-tier instance in middlewares.ts).
- Produces: `POST /store/phone-verification/change` (authed customer) body `{ phone: string, token: string }` → `200 { customer: { id, phone } }`. Storefront contract for Task 6's `changePhone` action.

- [ ] **Step 1: Extend the http spec (failing)** — authed customer: start+check for `purpose: 'phone-change'` → `POST /store/phone-verification/change { phone, token }` → 200; then `GET /store/customers/me` shows the new phone. Also: a `signup`-purpose token → 400; a token for a different phone → 400; unauthenticated → 401.

- [ ] **Step 2: Run, verify FAIL (404).**

- [ ] **Step 3: Implement**

```typescript
import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { E164_RE, verifyPhoneProof } from '../../../../utils/phone-verification';

// The ONLY way to set a new phone once enforcement is on (the /me gate in
// api/utils/phone-verification-guard.ts closes the core route). Actor comes
// from the verified bearer token, never the body.
type Body = { phone?: unknown; token?: unknown };

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { phone, token } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  if (!jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  const proof =
    typeof token === 'string'
      ? verifyPhoneProof(jwtSecret, token, 'phone-change')
      : null;
  if (!proof || proof.phone !== phone)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Phone verification required.');

  const customerService: ICustomerModuleService = req.scope.resolve(Modules.CUSTOMER);
  const customerId = req.auth_context.actor_id;
  await customerService.updateCustomers(customerId, { phone });
  res.json({ customer: { id: customerId, phone } });
}
```

- [ ] **Step 4: Register in `middlewares.ts`** (write-tier budget; extend the shared limiter's message resolver if its `/store/profile/` branch would mislabel this path — check the resolver in the `deliveryWriteRateLimit` construction):

```typescript
{
  // Verified phone change — authed write; shares the write-tier budget.
  matcher: '/store/phone-verification/change',
  method: 'POST',
  middlewares: [authenticate('customer', ['bearer']), deliveryWriteRateLimit],
},
```

- [ ] **Step 5: Run the http spec, verify PASS. Commit**

```bash
git add backend/packages/api/src/api/store/phone-verification/change backend/packages/api/src/api/middlewares.ts <http-spec-path>
git commit -m "feat(phone): verified phone-change route"
```

---

### Task 5: Forgot-password-by-phone route

**Files:**
- Create: `backend/packages/api/src/api/store/phone-verification/password-reset/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (one entry, reuse `authRateLimit`)
- Test: extend the Task-2 http spec

**Interfaces:**
- Consumes: Task 1 (`verifyPhoneProof`), core `generateResetPasswordTokenWorkflow` from `@medusajs/core-flows`, existing reset-token single-use guard (applies automatically — the returned token flows through `/auth/customer/emailpass/update`, already matched).
- Produces: `POST /store/phone-verification/password-reset` body `{ token: string }` → `200 { token: string, maskedEmail: string }`. Storefront redirects to the EXISTING `/reset-password` page with it (Task 7).

- [ ] **Step 1: Verify the core workflow's contract.** Read `node_modules/@medusajs/medusa/dist/api/auth/[actor_type]/[auth_provider]/reset-password/route.js` (backend `node_modules`) and the workflow it calls in `@medusajs/core-flows` (dist path near `auth/`). Confirm: exact workflow name/export, input shape (`entityId`, `actorType`, `provider`, `secret` — copy exactly what the core route passes), and that the workflow **result is the token string**. If the result is not the token, fall back to signing the reset JWT locally with the same claims/secret the provider's `validateToken` expects (read `@medusajs/auth-emailpass` dist to copy the claim names). Record what you found in the route's header comment.

- [ ] **Step 2: Extend the http spec (failing).** Seed a customer with a known phone + password (reuse the register/login helpers). Flow: start (`password-reset`) → check dev code → proof token → `POST /store/phone-verification/password-reset { token }` → expect `200`, a `token`, and `maskedEmail` matching `/^.\*+@/`. Then `POST /auth/customer/emailpass/update` with `Authorization: Bearer <token>` and a new password → login with the new password succeeds. Negative cases: proof with `signup` purpose → 400; phone matching zero customers → 404-shaped error; two customers sharing the phone → 400 with the "reset by email" message.

- [ ] **Step 3: Run, verify FAIL (404). Then implement**

```typescript
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { generateResetPasswordTokenWorkflow } from '@medusajs/core-flows';
import { verifyPhoneProof } from '../../../../utils/phone-verification';

// Exchanges phone-possession proof for the SAME single-use 15m reset token the
// email flow issues, so the whole downstream path is reused unchanged:
// /reset-password page → /auth/customer/emailpass/update → single-use guard.
// Running the core workflow also emits auth.password_reset, so the account's
// EMAIL gets the usual reset mail too — deliberate: it doubles as a security
// notification, and both links carry the same token, so using one dead-ends
// the other via the single-use guard.
//
// Enumeration stance: the caller has already proven possession of the phone
// (OTP passed), so "no account uses this phone" is disclosable to them —
// same standard the email-flow confirmation copy protects against, different
// trust level. Legacy phones stored non-E.164 (pre-2026-08 rows) won't match
// the exact-match lookup; those users reset by email. ponytail: exact match
// only, add normalization backfill only if support volume says so.
type Body = { token?: unknown };

const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
};

export async function POST(req: MedusaRequest<Body>, res: MedusaResponse): Promise<void> {
  const { token } = req.body ?? {};
  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  if (!jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  const proof =
    typeof token === 'string'
      ? verifyPhoneProof(jwtSecret, token, 'password-reset')
      : null;
  if (!proof)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Phone verification required.');

  const customerService: ICustomerModuleService = req.scope.resolve(Modules.CUSTOMER);
  const matches = await customerService.listCustomers(
    { phone: proof.phone, has_account: true },
    { select: ['id', 'email'], take: 2 },
  );
  if (matches.length === 0)
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No account uses this phone number.');
  if (matches.length > 1)
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'More than one account uses this phone number. Reset by email instead.',
    );

  const email = matches[0].email;
  // Input shape verified against the core reset-password route (Step 1) —
  // adjust here if your reading found different field names.
  const { result } = await generateResetPasswordTokenWorkflow(req.scope).run({
    input: {
      entityId: email,
      actorType: 'customer',
      provider: 'emailpass',
      secret: jwtSecret,
    },
  });
  res.json({ token: result, maskedEmail: maskEmail(email) });
}
```

Google-only accounts have no `emailpass` provider identity — the workflow throws. Catch that specific failure and rethrow as `MedusaError(NOT_ALLOWED, 'This account signs in with Google.')` (add an http-spec case if seeding a Google identity is feasible; otherwise cover with a unit-level note in the spec file).

- [ ] **Step 4: Register in `middlewares.ts`** — reuse the existing `authRateLimit` instance (credential-issuing endpoint, same family as login/register):

```typescript
{
  // Phone-proof → reset-token exchange. Public (pre-auth by nature); shares
  // the auth brute-force budget.
  matcher: '/store/phone-verification/password-reset',
  method: 'POST',
  middlewares: [authRateLimit],
},
```

- [ ] **Step 5: Run the http spec, verify PASS. Commit**

```bash
git add backend/packages/api/src/api/store/phone-verification/password-reset backend/packages/api/src/api/middlewares.ts <http-spec-path>
git commit -m "feat(phone): forgot-password-by-phone — proof exchanges for the core single-use reset token"
```

---

### Task 6: Storefront actions + signup OTP step

**Files:**
- Create: `src/lib/phone-verification.ts`
- Create: `src/lib/actions/phone-verification.ts`
- Create: `src/components/auth/PhoneOtpStep.tsx`
- Modify: `src/lib/actions/auth.ts` (signup forwards the proof header)
- Modify: `src/components/AuthForm.tsx` (signup OTP step)

**Interfaces:**
- Consumes: Task 2/4/5 route contracts; header name `x-phone-verification` (Task 3).
- Produces (used by Tasks 7–8):
  - `PHONE_VERIFICATION_REQUIRED: boolean` from `src/lib/phone-verification.ts`
  - `startPhoneOtp(input: { phone: string; purpose: PhoneOtpPurpose }): Promise<{ ok: true } | { ok: false; error: string }>`
  - `checkPhoneOtp(input: { phone: string; purpose: PhoneOtpPurpose; code: string }): Promise<{ ok: true; token: string } | { ok: false; error: string }>`
  - `changePhone(input: { phone: string; token: string }): Promise<{ ok: true; phone: string } | { ok: false; error: string }>`
  - `resetPasswordByPhone(input: { token: string }): Promise<{ ok: true; token: string; maskedEmail: string } | { ok: false; error: string }>`
  - `<PhoneOtpStep phone purpose onVerified(token) onBack />` client component
  - `signup` gains optional `phone_verification_token`.

- [ ] **Step 1: `src/lib/phone-verification.ts`**

```typescript
/** Storefront mirror of the backend's PHONE_VERIFICATION_REQUIRED flag.
 * NEXT_PUBLIC_* is inlined at BUILD time — set it in the DO build env, and
 * keep it in lockstep with the backend flag. Drift is UX-only: the backend
 * gate is authoritative (a skipped OTP step surfaces as a clear 400; an
 * extra OTP step is harmless). */
export const PHONE_VERIFICATION_REQUIRED =
  process.env.NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED === 'true';

export type PhoneOtpPurpose = 'signup' | 'phone-change' | 'password-reset';
```

- [ ] **Step 2: `src/lib/actions/phone-verification.ts`** — same shape as the existing actions (`'use server'`, boundary validation, `friendlyError`-style mapping, `logger`):

```typescript
'use server';

/**
 * Phone-OTP server actions. Thin proxies onto the backend's
 * /store/phone-verification/* routes — running server-side keeps the
 * publishable-key transport consistent with every other action. The backend
 * sees THIS server's single egress IP, not the visitor's — see the shipped
 * comment in
 * src/lib/actions/phone-verification.ts (corrected by plan 090; the version
 * originally drafted here claimed the opposite).
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { normalizePhone } from '@/lib/profile-validation';
import type { PhoneOtpPurpose } from '@/lib/phone-verification';

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// 429s carry a useful retry message; keep it, genericize everything else.
const messageOf = (error: unknown, fallback: string): string => {
  const msg = error instanceof Error ? error.message : '';
  return /try again in \d+s/i.test(msg) ? msg : fallback;
};

export async function startPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
}): Promise<{ ok: true } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone) return fail('Please enter a valid phone number for the selected country.');
  try {
    await sdk.client.fetch('/store/phone-verification/start', {
      method: 'POST',
      body: { phone, purpose: input.purpose },
    });
    return { ok: true };
  } catch (error) {
    logger.error('[phone-otp] start failed:', error);
    return fail(messageOf(error, 'Could not send the code. Please try again.'));
  }
}

export async function checkPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
  code: string;
}): Promise<{ ok: true; token: string } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone) return fail('Please enter a valid phone number for the selected country.');
  if (!/^\d{4,10}$/.test(input.code)) return fail('Enter the code from the SMS.');
  try {
    const { token } = await sdk.client.fetch<{ token: string }>(
      '/store/phone-verification/check',
      { method: 'POST', body: { phone, purpose: input.purpose, code: input.code } },
    );
    return { ok: true, token };
  } catch (error) {
    logger.error('[phone-otp] check failed:', error);
    return fail(messageOf(error, 'Invalid or expired code.'));
  }
}

export async function changePhone(input: {
  phone: string;
  token: string;
}): Promise<{ ok: true; phone: string } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone) return fail('Please enter a valid phone number for the selected country.');
  try {
    // Authed route — copy the explicit-Bearer idiom from updateCustomerProfile
    // in src/lib/data/customer.ts (httpOnly cookie → Authorization header).
    const { customer } = await authedFetch<{ customer: { phone: string } }>(
      '/store/phone-verification/change',
      { method: 'POST', body: { phone, token: input.token } },
    );
    return { ok: true, phone: customer.phone };
  } catch (error) {
    logger.error('[phone-otp] change failed:', error);
    return fail('Could not update your phone number. Please try again.');
  }
}

export async function resetPasswordByPhone(input: {
  token: string;
}): Promise<{ ok: true; token: string; maskedEmail: string } | Fail> {
  try {
    const data = await sdk.client.fetch<{ token: string; maskedEmail: string }>(
      '/store/phone-verification/password-reset',
      { method: 'POST', body: { token: input.token } },
    );
    return { ok: true, ...data };
  } catch (error) {
    logger.error('[phone-otp] reset exchange failed:', error);
    return fail(messageOf(error, 'Could not verify this phone. Reset by email instead.'));
  }
}
```

`authedFetch` is a sketch name: **read `src/lib/data/customer.ts` first** and reuse its actual authenticated-fetch helper (or inline the same cookie→Bearer pattern it uses). Match, don't invent.

- [ ] **Step 3: `PhoneOtpStep.tsx`** — one reusable client component, styled with the AuthForm chrome (reuse `PHONE_INPUT_CLASS`-equivalent classes from the file it mounts in):

```tsx
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { startPhoneOtp, checkPhoneOtp } from '@/lib/actions/phone-verification';
import type { PhoneOtpPurpose } from '@/lib/phone-verification';

const RESEND_COOLDOWN_S = 30;

/** Code-entry step shared by signup, phone-change, and forgot-by-phone.
 * The PARENT sends the first code (so it can gate on its own validation);
 * this step owns re-sends, the code input, and the check call. */
export function PhoneOtpStep({
  phone,
  purpose,
  onVerified,
  onBack,
}: {
  phone: string;
  purpose: PhoneOtpPurpose;
  onVerified: (token: string) => void | Promise<void>;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => c - 1), 1_000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    const result = await checkPhoneOtp({ phone, purpose, code });
    if (result.ok) {
      await onVerified(result.token); // parent owns the next transition
      return; // parent unmounts us; don't touch state after
    }
    setBusy(false);
    setError(result.error);
  }

  async function onResend() {
    if (busy || cooldown > 0) return;
    setError(null);
    const result = await startPhoneOtp({ phone, purpose });
    if (!result.ok) setError(result.error);
    setCooldown(RESEND_COOLDOWN_S);
  }

  return (
    <div className="w-full">
      <p className="text-sm text-white/50">
        Enter the 6-digit code we sent to <span className="text-white">{phone}</span>.
      </p>
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <input
          ref={inputRef}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d*"
          maxLength={10}
          placeholder="Verification code"
          aria-label="Verification code"
          className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.05] px-3 text-center text-lg tracking-[0.3em] text-white placeholder:text-sm placeholder:tracking-normal placeholder:text-white/50 focus:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          required
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-300 text-sm font-semibold text-neutral-950 transition-colors hover:to-neutral-100 disabled:opacity-70"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Verify
        </button>
      </form>
      <p aria-live="assertive" aria-atomic="true"
         className={error ? 'mt-3 text-center text-[12px] text-red-400' : 'sr-only'}>
        {error}
      </p>
      <div className="mt-4 flex items-center justify-between text-[13px] text-white/50">
        <button type="button" onClick={onBack} className="hover:text-white">Back</button>
        <button
          type="button"
          onClick={onResend}
          disabled={cooldown > 0}
          className="font-semibold text-white disabled:font-normal disabled:text-white/40"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `signup` action forwards the proof.** In `src/lib/actions/auth.ts`, add `phone_verification_token?: string` to the `signup` input; when `PHONE_VERIFICATION_REQUIRED` (import from `@/lib/phone-verification`) is true and a token is present, pass it as a header on the customer-create call; when required and absent, fail fast:

```typescript
  if (PHONE_VERIFICATION_REQUIRED && !input.phone_verification_token)
    return { ok: false, error: 'Please verify your phone number first.' };
  // ...
  await sdk.store.customer.create(
    { email, first_name, phone },
    {},
    {
      Authorization: `Bearer ${registerToken}`,
      ...(input.phone_verification_token
        ? { 'x-phone-verification': input.phone_verification_token }
        : {}),
    },
  );
```

- [ ] **Step 5: AuthForm signup OTP step.** Add state `otp: { phone: string; pending: { email: string; password: string; first_name: string } } | null`. In `onSubmit` (signup branch), when `PHONE_VERIFICATION_REQUIRED`: after the existing client-side validation passes, call `startPhoneOtp({ phone, purpose: 'signup' })`; on success `setOtp({ phone: normalizePhone(phone)!, pending: { email, password, first_name } })` instead of calling `signup`. Render:

```tsx
  if (isSignup && otp) {
    return (
      <div className="w-full">
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Verify your phone
        </h2>
        <PhoneOtpStep
          phone={otp.phone}
          purpose="signup"
          onBack={() => setOtp(null)}
          onVerified={async (token) => {
            const result = await signup({
              ...otp.pending,
              phone: otp.phone,
              phone_verification_token: token,
            });
            if (result.ok) {
              setCustomer(result.customer);
              onSuccess?.();
              router.refresh();
              return;
            }
            setOtp(null);
            setNote({ text: result.error });
          }}
        />
      </div>
    );
  }
```

When the flag is off, the branch never triggers — today's flow byte-for-byte.

- [ ] **Step 6: Verify in the browser** (flag on locally): set `NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true` + backend `PHONE_VERIFICATION_REQUIRED=true` (dev servers, dev code `000000`), run the signup flow end-to-end via the repo's standard verification path (`npm run build` + `pwsh scripts/serve-standalone.ps1 -Port 4000`, or a Playwright script in `scripts/` — NOT `next dev`, NOT Chrome MCP, per CLAUDE.md). Screenshot the OTP step; confirm a wrong code errors inline, `000000` completes signup, and the created account's phone shows in settings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/phone-verification.ts src/lib/actions/phone-verification.ts src/components/auth/PhoneOtpStep.tsx src/lib/actions/auth.ts src/components/AuthForm.tsx
git commit -m "feat(phone): signup OTP step + phone-verification server actions"
```

---

### Task 7: Forgot-password-by-phone UI

**Files:**
- Modify: `src/components/AuthForm.tsx` (forgot sub-view grows a Phone method)
- Verify/Modify: the `/reset-password` page component(s) under `src/app/reset-password/`

**Interfaces:**
- Consumes: Task 6 (`startPhoneOtp`, `checkPhoneOtp`, `resetPasswordByPhone`, `PhoneOtpStep`, `PHONE_VERIFICATION_REQUIRED`), existing `/reset-password` page + `resetPassword` action.
- Produces: user-visible flow — Forgot password → "Use phone instead" → PhoneField → OTP → redirect to `/reset-password?token=…`.

- [ ] **Step 1: Read `/reset-password`'s param contract.** Read the page + client component under `src/app/reset-password/`. If it hard-requires the `email` query param for anything beyond display, make it tolerate absence (the phone flow has only a masked email). If it's display-only, pass `email=<maskedEmail>` through and touch nothing.

- [ ] **Step 2: Extend the forgot sub-view.** Replace `forgot: 'none' | 'form' | 'sent'` with `forgot: 'none' | 'form' | 'sent' | 'phone' | 'phone-otp'` plus `forgotPhone: string`. In the `'form'` view, under the email submit button (only when `PHONE_VERIFICATION_REQUIRED`):

```tsx
  <button
    type="button"
    onClick={() => { setForgot('phone'); setNote(null); }}
    className="self-center py-2 text-[12px] text-white/70 hover:text-white"
  >
    Use phone number instead
  </button>
```

`'phone'` view: a `PhoneField` (reuse `PHONE_INPUT_CLASS`) + submit that validates via `normalizePhone`, calls `startPhoneOtp({ phone, purpose: 'password-reset' })`, stores the phone, flips to `'phone-otp'`. Copy under the field: "If an account uses this number, we'll text a code." — sent unconditionally (the backend decides silently whether SMS actually goes out; no oracle in the UI either).

`'phone-otp'` view:

```tsx
  <PhoneOtpStep
    phone={forgotPhone}
    purpose="password-reset"
    onBack={() => setForgot('phone')}
    onVerified={async (proofToken) => {
      const result = await resetPasswordByPhone({ token: proofToken });
      if (result.ok) {
        window.location.assign(
          `/reset-password?token=${encodeURIComponent(result.token)}&email=${encodeURIComponent(result.maskedEmail)}`,
        );
        return;
      }
      setForgot('phone');
      setNote({ text: result.error });
    }}
  />
```

The "No account uses this phone number." / "Reset by email instead." errors surface here — post-OTP, so disclosure to the proven phone-holder is the designed stance (Task 5 comment).

- [ ] **Step 3: Verify in the browser** (same serving rules as Task 6 Step 6): full loop — forgot → phone → dev code → lands on `/reset-password` → set a new password → log in with it. Screenshot each step.

- [ ] **Step 4: Commit**

```bash
git add src/components/AuthForm.tsx src/app/reset-password
git commit -m "feat(phone): forgot-password-by-phone flow in the auth modal"
```

---

### Task 8: Settings — verified phone change

**Files:**
- Modify: `src/lib/actions/customer.ts`
- Modify: `src/components/account/SettingsForm.tsx`

**Interfaces:**
- Consumes: Task 6 (`startPhoneOtp`, `changePhone`, `PhoneOtpStep`, `PHONE_VERIFICATION_REQUIRED`).
- Produces: settings phone UX — read-only value + "Change" affordance when enforcement is on; unchanged legacy form when off.

- [ ] **Step 1: Stop `updateProfile` from writing phone under enforcement.** In `src/lib/actions/customer.ts`, when `PHONE_VERIFICATION_REQUIRED` is true, omit `phone` from the `StoreUpdateCustomer` body entirely (leave names untouched) and drop the phone-validation branch on that path — the backend gate (Task 3) would 400 the whole save otherwise. Comment why: phone writes go through `changePhone`.

- [ ] **Step 2: SettingsForm.** When `PHONE_VERIFICATION_REQUIRED`:
  - Replace the editable `PhoneField` block with the current phone rendered read-only (same visual treatment as the read-only email field) + a "Change" button.
  - "Change" opens an inline panel (state-machine in this file, no new dialog primitive): `PhoneField` for the new number → "Send code" (`startPhoneOtp({ phone, purpose: 'phone-change' })`) → `PhoneOtpStep` → `onVerified` calls `changePhone({ phone, token })` → on success update local display + `setNote({ ok: true, text: 'Phone updated.' })`, `router.refresh()`.
  - When the flag is off: render exactly today's editable field; `updateProfile` keeps carrying phone. No behavior change.

- [ ] **Step 3: Verify in the browser** (flag on): change phone with dev code, confirm settings + `GET /store/customers/me` show the new number; confirm the profile save (names) still works alongside. Also verify flag-off build renders the old form.

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/customer.ts src/components/account/SettingsForm.tsx
git commit -m "feat(phone): verified phone change from account settings"
```

---

### Task 9: Rollout — env, docs, prod checklist

**Files:**
- Modify: `CONTEXT.md` (document the feature flag + env surface; follow the existing domain-doc conventions in `docs/agents/domain.md`)
- No `.env.example` edits (guard-secrets blocks them — memory)

- [ ] **Step 1: Docs.** Add a short section to `CONTEXT.md`: the three flows, the proof-token design (stateless, 10m TTL, purposes), the env matrix (backend + storefront + limiter knobs from Global Constraints), the dev code (`000000` / `PHONE_OTP_DEV_CODE`), and the two accepted ceilings (proof replay within TTL; legacy non-E.164 phones can't phone-reset).

- [ ] **Step 2: Twilio account setup (operator-interactive — surface as a checklist, don't automate credentials):**
  1. Create a Twilio Verify **Service** (Console → Verify → Services) — SMS channel on, friendly name "Polycards".
  2. Enable **Fraud Guard** (Verify → Settings) and set **Geo Permissions** to the operator's expected customer countries only (MY first; SMS-pumping runs abuse open geo).
  3. Note ~cost: per-verification fee + per-SMS rate (varies by country; MY is cheap, verify current pricing).
  4. Collect `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`.

- [ ] **Step 3: Deploy order (flag-off first, then flip):**
  1. Merge + deploy everything with both flags **unset** — zero behavior change in prod; e2e/CI untouched.
  2. Add the three Twilio secrets + `PHONE_VERIFICATION_REQUIRED=true` to the backend DO app spec **at deploy time with real values** (never pre-add `**SECRET**` placeholders — do-apply trap), app-level like the Resend vars (subscriber/worker parity).
  3. Add `NEXT_PUBLIC_PHONE_VERIFICATION_REQUIRED=true` to the **storefront build env** (it's build-time-inlined) and rebuild.
  4. Smoke on prod: signup with a real phone (operator's), phone change, forgot-by-phone. Watch backend logs for `[phone-otp]` warns and Twilio console for delivery.
  5. Rollback lever: flip `PHONE_VERIFICATION_REQUIRED` off (backend) — every gate opens instantly; storefront flag can lag (extra OTP UI steps still work because dev-code mode is prod-refused… so flip the storefront flag + rebuild promptly too).

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(phone): phone-verification env surface, dev transport, rollout checklist"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** signup OTP (Tasks 1–3, 6), phone change (Tasks 4, 8), forgot-by-phone (Tasks 5, 7) — all three requested flows have backend enforcement + UI.
- **Known accepted ceilings** (each carries an in-code comment): proof-token replay within its 10m TTL (same proven phone only); phoneless direct-API signup (pre-existing scope, unchanged); legacy non-E.164 phones excluded from phone-reset; storefront/backend flag drift is UX-only; start-route timing oracle for password-reset phones (mirrors the email flow's shape).
- **Type consistency spot-checks:** header `x-phone-verification` (Tasks 3, 6); purposes `'signup' | 'phone-change' | 'password-reset'` everywhere; `checkPhoneOtpCode` (util) vs `checkPhoneOtp` (server action) — distinct names, distinct layers; proof verify returns `{ phone } | null` in both consumers.
- **Deliberate verify-before-trust steps** (marked in-task): core reset workflow contract (Task 5 Step 1), `configModule` resolution idiom (Task 2 Step 4), authed-fetch helper in `src/lib/data/customer.ts` (Task 6 Step 2), `/reset-password` param contract (Task 7 Step 1), http-spec folder + jest invocation (Task 2). These are reads of files this plan's author could not fully verify — do them before writing the dependent code.
