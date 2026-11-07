import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { DESK_BOT_ACTOR } from '../reports/admin/proxy';

// Every admin login needs an authenticator app (owner, 2026-11-07). Medusa asks
// for the 6-digit code at sign-in only once a login has one set up, and never
// makes a login set one up, so that rule lives here:
//
//   - /admin/* refuses a staff login without an authenticator, with
//     MFA_SETUP_REQUIRED, which the admin app answers with the setup screen.
//     It also refuses a sign-in older than the authenticator (MFA_SIGN_IN_
//     REQUIRED): a session or token from before the setup never answered a
//     code, so it must sign in again, with one.
//   - /auth/mfa/* is for staff alone (a customer who set one up could no
//     longer sign in to the shop), and changing an authenticator or backup
//     codes needs a full sign-in. The token a password alone returns while the
//     code is still due may only answer that code: were it allowed to add an
//     authenticator of its own, a stolen password would be enough again.
//   - After a Super Admin's reset, only a sign-in made since then can set up
//     the new authenticator, and backup codes are made once, at setup.
//
// The first setup itself trusts whoever signs in first with the password: the
// rollout has every admin set up at once (owner's runbook).

type AuthContext = {
  actor_id?: string;
  actor_type?: string;
  auth_identity_id?: string;
  /** When the token behind this sign-in was issued, in seconds. A cookie
   *  session keeps the token's claims (core auth/session route). */
  iat?: number;
};
const authOf = (req: MedusaRequest): AuthContext | undefined =>
  (req as unknown as { auth_context?: AuthContext }).auth_context;

type Db = {
  raw(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
const dbOf = (scope: MedusaContainer) =>
  scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Db;

export const MFA_SETUP_REQUIRED = 'mfa_setup_required';
export const MFA_SIGN_IN_REQUIRED = 'mfa_sign_in_required';

// The database's clock and this server's may differ by a little.
export const CLOCK_SLACK_MS = 2_000;
const signedInAt = (auth: AuthContext | undefined): number | null =>
  typeof auth?.iat === 'number' ? auth.iat * 1000 : null;

// A found authenticator is kept a minute, so that every admin request is not a
// query. None found is never kept, so a login that has just set one up gets in
// at once. A Super Admin's reset reaches another server's copy at most a
// minute late.
const KEEP_MS = 60_000;
const kept = new Map<string, { since: number; until: number }>();

/** When this login's authenticator was added (ms), or null without one. */
export async function authenticatorSince(
  scope: MedusaContainer,
  authIdentityId: string | undefined,
  now: number = Date.now(),
): Promise<number | null> {
  if (!authIdentityId) return null;
  const hit = kept.get(authIdentityId);
  if (hit && hit.until > now) return hit.since;
  // The auth module's own table: its DTO does not carry created_at.
  const { rows } = await dbOf(scope).raw(
    "SELECT min(created_at) AS since FROM auth_mfa_factor WHERE auth_identity_id = ? AND provider = 'totp' AND status = 'enabled' AND deleted_at IS NULL",
    [authIdentityId],
  );
  if (!rows[0]?.since) {
    kept.delete(authIdentityId);
    return null;
  }
  const since = new Date(rows[0].since as string).getTime();
  kept.set(authIdentityId, { since, until: now + KEEP_MS });
  return since;
}

/** The login (auth identity) of an admin user, for a token this server mints
 *  on their behalf (the assistant's scheduled tasks): the guard below checks
 *  that login's authenticator like any other. */
export async function authIdentityOfUser(
  scope: MedusaContainer,
  userId: string,
): Promise<string | null> {
  const { rows } = await dbOf(scope).raw(
    "SELECT id FROM auth_identity WHERE deleted_at IS NULL AND app_metadata->>'user_id' = ? ORDER BY created_at LIMIT 1",
    [userId],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

/** Drops this server's kept answer, after a reset. */
export const forgetAuthenticator = (authIdentityId: string): void => {
  kept.delete(authIdentityId);
};

/**
 * /admin/*: a staff login without an authenticator gets nothing but the setup,
 * and one signed in before its authenticator was added must sign in again.
 * Runs after the framework's own authenticate on /admin. Left to the routes
 * themselves: an API-key caller, a request before sign-in is complete (no
 * actor yet, as when accepting an invite), and the desk bots' read-only
 * proxy, whose 60-second token is minted in this process for no login.
 */
export async function requireAdminAuthenticator(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const auth = authOf(req);
  if (
    auth?.actor_type !== 'user' ||
    !auth.actor_id ||
    auth.actor_id === DESK_BOT_ACTOR
  ) {
    return next();
  }
  let since: number | null;
  try {
    since = await authenticatorSince(req.scope, auth.auth_identity_id);
  } catch (err) {
    return next(err);
  }
  if (since === null) {
    res.status(403).json({
      type: MFA_SETUP_REQUIRED,
      message:
        'Set up two-step sign-in with an authenticator app to use the admin.',
    });
    return;
  }
  const at = signedInAt(auth);
  if (at !== null && at >= since - CLOCK_SLACK_MS) return next();
  // The 401 sends the admin app to sign-in. A cookie session goes first, so
  // the next sign-in starts a new one.
  const answer = () =>
    res.status(401).json({
      type: MFA_SIGN_IN_REQUIRED,
      message: 'Sign in again with your authenticator code.',
    });
  const session = (
    req as unknown as {
      session?: { auth_context?: unknown; destroy(cb: () => void): void };
    }
  ).session;
  if (session?.auth_context) session.destroy(answer);
  else answer();
}

/** /auth/mfa/* changes: a staff login that has finished signing in. */
export function requireSignedInAdmin(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const auth = authOf(req);
  if (auth?.actor_type === 'user' && auth.actor_id) return next();
  res.status(401).json({
    type: 'unauthorized',
    message: 'Finish signing in to the admin first.',
  });
}

/** POST /auth/mfa/factors: one authenticator app per login; a new phone needs
 *  a Super Admin's reset first, and then a sign-in made since the reset. */
export async function allowOneAuthenticator(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const provider = (req.body as { provider?: unknown } | undefined)?.provider;
  if (provider !== 'totp') {
    res.status(400).json({
      type: 'invalid_data',
      message: 'Two-step sign-in uses an authenticator app (provider "totp").',
    });
    return;
  }
  const auth = authOf(req)!;
  try {
    if (await authenticatorSince(req.scope, auth.auth_identity_id)) {
      res.status(409).json({
        type: 'conflict',
        message:
          'This login already has an authenticator app. To move to a new phone, ask a Super Admin to reset two-step sign-in.',
      });
      return;
    }
    const { rows } = await dbOf(req.scope).raw(
      'SELECT max(deleted_at) AS reset_at FROM auth_mfa_factor WHERE auth_identity_id = ?',
      [auth.auth_identity_id],
    );
    const resetAt = rows[0]?.reset_at
      ? new Date(rows[0].reset_at as string).getTime()
      : null;
    const at = signedInAt(auth);
    if (resetAt !== null && (at === null || at < resetAt - CLOCK_SLACK_MS)) {
      res.status(401).json({
        type: MFA_SIGN_IN_REQUIRED,
        message:
          'Two-step sign-in was reset. Sign in again to set up your new authenticator.',
      });
      return;
    }
    // The phone app names the account "Polycards Admin: <their email>",
    // whatever the page sent. Set on both, whichever the framework read.
    const user = await req.scope
      .resolve(Modules.USER)
      .retrieveUser(auth.actor_id!, { select: ['email'] });
    (req.body as Record<string, unknown>).label = user.email;
    const validated = (
      req as unknown as { validatedBody?: Record<string, unknown> }
    ).validatedBody;
    if (validated) validated.label = user.email;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** POST /auth/mfa/recovery-codes: once, at setup. New ones later would let a
 *  borrowed session mint a way back in; a lost set goes through a reset. */
export async function allowFirstBackupCodes(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  try {
    const { rows } = await dbOf(req.scope).raw(
      'SELECT count(*)::int AS n FROM auth_mfa_recovery_code WHERE deleted_at IS NULL AND auth_identity_id = ?',
      [authOf(req)?.auth_identity_id ?? ''],
    );
    if (Number(rows[0]?.n ?? 0) === 0) return next();
  } catch (err) {
    return next(err);
  }
  res.status(409).json({
    type: 'conflict',
    message:
      'Backup codes were already made for this login. For new ones, ask a Super Admin to reset two-step sign-in.',
  });
}
