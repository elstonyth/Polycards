import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  Modules,
} from '@medusajs/framework/utils';
import { DESK_BOT_ACTOR } from '../reports/admin/proxy';

// Every admin login needs an authenticator app (owner, 2026-11-07). Medusa asks
// for the 6-digit code at sign-in only once a login has one set up, and never
// makes a login set one up, so that rule lives here:
//
//   - /admin/* refuses a staff login without an authenticator, with
//     MFA_SETUP_REQUIRED, which the admin app answers with the setup screen.
//   - /auth/mfa/* is for staff alone (a customer who set one up could no
//     longer sign in to the shop), and changing an authenticator or backup
//     codes needs a full sign-in. The token a password alone returns while the
//     code is still due may only answer that code: were it allowed to add an
//     authenticator of its own, a stolen password would be enough again.

type AuthContext = {
  actor_id?: string;
  actor_type?: string;
  auth_identity_id?: string;
};
const authOf = (req: MedusaRequest): AuthContext | undefined =>
  (req as unknown as { auth_context?: AuthContext }).auth_context;

export const MFA_SETUP_REQUIRED = 'mfa_setup_required';

// A yes is kept a minute, so that every admin request is not a query. A no is
// never kept, so a login that has just set one up gets in at once. A Super
// Admin's reset reaches another server's copy at most a minute late.
const KEEP_MS = 60_000;
const confirmed = new Map<string, number>();

/** Whether this login has an enabled authenticator. */
export async function hasAuthenticator(
  scope: MedusaContainer,
  authIdentityId: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!authIdentityId) return false;
  if ((confirmed.get(authIdentityId) ?? 0) > now) return true;
  const factors = await scope
    .resolve(Modules.AUTH)
    .listAuthMfa({ auth_identity_id: authIdentityId, status: 'enabled' });
  const yes = factors.some((f: { provider?: string }) => f.provider === 'totp');
  if (yes) confirmed.set(authIdentityId, now + KEEP_MS);
  else confirmed.delete(authIdentityId);
  return yes;
}

/** The login (auth identity) of an admin user, for a token this server mints
 *  on their behalf (the assistant's scheduled tasks): the guard below checks
 *  that login's authenticator like any other. */
export async function authIdentityOfUser(
  scope: MedusaContainer,
  userId: string,
): Promise<string | null> {
  const db = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
    raw(sql: string, values: unknown[]): Promise<{ rows: { id: string }[] }>;
  };
  const { rows } = await db.raw(
    "SELECT id FROM auth_identity WHERE deleted_at IS NULL AND app_metadata->>'user_id' = ? ORDER BY created_at LIMIT 1",
    [userId],
  );
  return rows[0]?.id ?? null;
}

/** Drops this server's kept yes, after a reset. */
export const forgetAuthenticator = (authIdentityId: string): void => {
  confirmed.delete(authIdentityId);
};

/**
 * /admin/*: a staff login without an authenticator gets nothing but the setup.
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
  try {
    if (await hasAuthenticator(req.scope, auth.auth_identity_id)) return next();
  } catch (err) {
    return next(err);
  }
  res.status(403).json({
    type: MFA_SETUP_REQUIRED,
    message:
      'Set up two-step sign-in with an authenticator app to use the admin.',
  });
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
 *  a Super Admin's reset first. */
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
  const auth = authOf(req);
  try {
    if (!(await hasAuthenticator(req.scope, auth?.auth_identity_id))) {
      // The phone app names the account "Polycards Admin: <their email>",
      // whatever the page sent. Set on both, whichever the framework read.
      const user = await req.scope
        .resolve(Modules.USER)
        .retrieveUser(auth!.actor_id!, { select: ['email'] });
      const body = req.body as Record<string, unknown>;
      body.label = user.email;
      const validated = (req as unknown as { validatedBody?: Record<string, unknown> })
        .validatedBody;
      if (validated) validated.label = user.email;
      return next();
    }
  } catch (err) {
    return next(err);
  }
  res.status(409).json({
    type: 'conflict',
    message:
      'This login already has an authenticator app. To move to a new phone, ask a Super Admin to reset two-step sign-in.',
  });
}
