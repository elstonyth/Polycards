// Admin two-step sign-in (owner, 2026-11-07). Every admin login uses an
// authenticator app (Google Authenticator, Microsoft Authenticator, Ente Auth
// and the like); the backend refuses the admin to a login without one
// (api/utils/admin-mfa-guard.ts). Mercur's own login page knows nothing of the
// code step, so sign-in and setup are our pages: routes/sign-in and
// routes/two-step-setup. These are their calls to Medusa's auth routes.

declare const __BACKEND_URL__: string;
declare const __BASE__: string;

/** What /admin/* answers a login that has no authenticator yet. */
export const MFA_SETUP_REQUIRED = 'mfa_setup_required';

export const SIGN_IN_PATH = '/sign-in';
export const SETUP_PATH = '/two-step-setup';

const base = () =>
  (typeof __BASE__ !== 'undefined' ? __BASE__ : '/').replace(/\/+$/, '');

/** A page of this admin as a browser URL. */
export const adminUrl = (path: string): string => `${base()}${path}`;

/** Digits only, at most `max` of them: what a code box keeps of a paste like
 *  "123 456". */
export const digitsOnly = (input: string, max = 6): string =>
  input.replace(/\D/g, '').slice(0, max);

/** Where to go after signing in: the page asked for, but only a path inside
 *  this admin, never another site. */
export function afterSignIn(redirect: string | null): string {
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//')) {
    return '/';
  }
  if (redirect.startsWith(SIGN_IN_PATH) || redirect.startsWith(SETUP_PATH)) {
    return '/';
  }
  return redirect;
}

/** The secret as an authenticator app's "enter a key" field shows it: groups
 *  of four. */
export const groupKey = (secret: string): string =>
  secret.replace(/(.{4})/g, '$1 ').trim();

export class TwoStepError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  init: { body?: unknown; token?: string; method?: 'POST' | 'DELETE' } = {},
): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    method: init.method ?? 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof data.message === 'string' && data.message
        ? data.message
        : `Request failed (${res.status}).`;
    throw new TwoStepError(message, res.status);
  }
  return data as T;
}

export type SignInStep =
  | { kind: 'code'; challengeId: string; token: string }
  | { kind: 'signed-in'; token: string };

/** The password step. A login with an authenticator answers with a code
 *  challenge; one without (before its setup) is signed in already. */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInStep> {
  const data = await call<{
    token: string;
    mfa_required?: boolean;
    mfa_challenge?: { id: string };
  }>('/auth/user/emailpass', { body: { email, password } });
  if (data.mfa_required && data.mfa_challenge?.id) {
    return {
      kind: 'code',
      challengeId: data.mfa_challenge.id,
      token: data.token,
    };
  }
  return { kind: 'signed-in', token: data.token };
}

/** The code step: the app's 6-digit code, or one of the backup codes. */
export async function answerCode(
  step: Extract<SignInStep, { kind: 'code' }>,
  method: 'totp' | 'recovery_code',
  code: string,
): Promise<string> {
  const data = await call<{ token: string }>(
    `/auth/mfa/challenges/${step.challengeId}/verify`,
    { body: { method, code }, token: step.token },
  );
  return data.token;
}

/** Signs this browser out (ends the cookie session). */
export async function endSession(): Promise<void> {
  await call('/auth/session', { method: 'DELETE' });
}

/** Turns a finished sign-in into the admin's cookie session. */
export async function startSession(token: string): Promise<void> {
  await call('/auth/session', { token });
}

export type Enrollment = {
  factorId: string;
  secret: string;
  otpauthUrl: string;
};

// The setup in progress, kept for this tab: a phone's browser often reloads
// the page after a switch to the authenticator app, and a reload must show
// the same QR code and key, not a new one (Yuan, 2026-11-07). Cleared once
// confirmed. Storage can be missing (private mode): then a reload starts over.
const ENROLLMENT_KEY = 'pc.twoStep.enrollment';
type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This tab's storage for the setup in progress, or null where there is none. */
export const tabStore = (): KeyStore | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** The setup this tab started and has not confirmed yet. */
export function keptEnrollment(store: KeyStore | null): Enrollment | null {
  try {
    const raw = store?.getItem(ENROLLMENT_KEY);
    if (!raw) return null;
    const e = JSON.parse(raw) as Partial<Enrollment>;
    return typeof e.factorId === 'string' &&
      typeof e.secret === 'string' &&
      typeof e.otpauthUrl === 'string'
      ? { factorId: e.factorId, secret: e.secret, otpauthUrl: e.otpauthUrl }
      : null;
  } catch {
    return null;
  }
}

/** Keeps (or, with null, forgets) the setup in progress. */
export function keepEnrollment(
  store: KeyStore | null,
  enrollment: Enrollment | null,
): void {
  try {
    if (enrollment) store?.setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
    else store?.removeItem(ENROLLMENT_KEY);
  } catch {
    // No storage: a reload starts a new setup, which the server allows.
  }
}

/** Setup, step one: a new authenticator for this login, not yet in use. */
export async function startAuthenticator(): Promise<Enrollment> {
  const data = await call<{
    mfa_factor: { id: string };
    secret: string;
    otpauth_url: string;
  }>('/auth/mfa/factors', { body: { provider: 'totp' } });
  return {
    factorId: data.mfa_factor.id,
    secret: data.secret,
    otpauthUrl: data.otpauth_url,
  };
}

/** Setup, step two: a code from the app proves it was added; from here every
 *  sign-in asks for one. */
export async function confirmAuthenticator(
  factorId: string,
  code: string,
): Promise<void> {
  await call(`/auth/mfa/factors/${factorId}/verify`, { body: { code } });
}

/** Ten one-time backup codes, shown once. Making new ones replaces the old. */
export async function makeBackupCodes(): Promise<string[]> {
  const data = await call<{ recovery_codes: string[] }>(
    '/auth/mfa/recovery-codes',
  );
  return data.recovery_codes;
}

/** A Super Admin resets another admin's two-step sign-in (lost or new phone). */
export async function resetTwoStep(userId: string): Promise<void> {
  await call(`/admin/users/${encodeURIComponent(userId)}/mfa/reset`);
}
