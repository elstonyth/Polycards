// Single source of truth for "is Resend wired?", imported by BOTH medusa-config.ts
// (which decides whether to REGISTER the provider) and the password-reset subscriber
// (which decides whether to SEND through it).
//
// Keeping one predicate is load-bearing, not tidiness. If the two gates could drift,
// a partial config — RESEND_API_KEY set but RESEND_FROM_EMAIL unset — would leave the
// notification module with no provider on the `email` channel while the subscriber
// still called createNotifications({ channel: 'email' }). That path throws
// MedusaError.NOT_FOUND ("Could not find a notification provider for channel: email",
// @medusajs/notification/dist/services/notification-module-service.js) from inside an
// event handler, which is strictly worse than the clean warn it replaced. Both env
// vars are required because the provider's validateOptions rejects a missing `from`.
export type ResendEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_REPLY_TO?: string;
};

export const isResendConfigured = (env: ResendEnv): boolean =>
  Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
