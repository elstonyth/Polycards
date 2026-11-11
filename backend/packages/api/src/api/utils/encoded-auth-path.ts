import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';

/**
 * Refuse an `/auth/*` request whose PATH carries a percent-escape
 * (backend audit 2026-11-11, finding 1).
 *
 * Medusa registers middlewares on the raw path, but Express decodes route
 * params, so `POST /auth/customer/%65mailpass` reaches the emailpass handler
 * while skipping every literal-path guard: the login limiters
 * (`/auth/*\/emailpass`), the staff-invite gate, the seller block
 * (`/auth/member/*`) and the reset-link single-use check. On prod the DO
 * ingress decodes the path first (probe 11-11), so this is defence in depth for
 * any host reached without that ingress: local, the test harness, a future one.
 *
 * No real auth path needs a `%`: actor types, providers and the fixed segments
 * are plain ASCII words. Only the pathname is checked, NOT the query string:
 * the Google OAuth callback's query legitimately carries escapes.
 *
 * The pathname comes from `req.originalUrl`, not `req.path`: a method-less
 * middleware is mounted with `app.use(matcher)`, which strips the matched
 * prefix from `req.url`/`req.path`, so `req.path` here would not include the
 * escaped segment at all.
 *
 * 404, the same answer `blockUnusedSurface` gives, so a probe learns nothing.
 */
export const refuseEncodedAuthPath = (
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  const pathname = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (pathname.includes('%')) {
    next(new MedusaError(MedusaError.Types.NOT_FOUND, 'Not found'));
    return;
  }
  next();
};
