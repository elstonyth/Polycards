import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';

// Hard ceiling on one admin login (2026-10-30). sessionOptions.rolling in
// medusa-config renews the session cookie on every request, so a login that
// keeps being used — or a tab left open on a page that polls — would never
// expire. That matters because the roles a session acts with are copied into
// it at sign-in (check-permissions reads auth_context.app_metadata.roles): a
// role taken away, or a user deleted, keeps working until the session ends.
// The cap bounds that to one day, the same as a daily sign-in.
//
// The clock starts on the session's first /admin request, which follows sign-in
// immediately; sessions already open at deploy start theirs then. Bearer and
// API-key callers carry no cookie session and are left to their own expiry.
export const ADMIN_SESSION_MAX_MS = 24 * 60 * 60 * 1000;

type CappedSession = {
  auth_context?: unknown;
  started_at?: number;
  destroy: (cb: (err?: unknown) => void) => void;
};

export function capAdminSessionAge(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
  now: number = Date.now(),
): void {
  const session = (req as unknown as { session?: CappedSession }).session;
  if (!session?.auth_context) return next();
  session.started_at ??= now;
  if (now - session.started_at <= ADMIN_SESSION_MAX_MS) return next();
  // Same answer the framework gives a signed-out request, so the admin's
  // login redirect (apps/admin/src/lib/login-redirect.ts) takes over.
  session.destroy(() => {
    res.status(401).json({ message: 'Unauthorized' });
  });
}
