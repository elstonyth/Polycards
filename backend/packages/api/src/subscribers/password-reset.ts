import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';

// Dev-mode "mail" delivery for the forgot-password flow: until a real
// notification provider (Resend/SendGrid) lands, the reset link is logged at
// WARN so it stands out in (and is greppable from) the backend console.
// Swapping in real mail later means replacing the logger call with a
// notification-module send — the event payload and link stay the same.
//
// Payload of auth.password_reset (emitted by core's
// generateResetPasswordTokenWorkflow): entity_id = the identifier the actor
// typed (their email for emailpass), actor_type = "customer" | "user" | ...,
// token = the 15m single-use reset JWT.
export default async function passwordResetHandler({
  event: { data },
  container,
}: SubscriberArgs<{ entity_id: string; actor_type: string; token: string }>) {
  const logger = container.resolve('logger');

  // SECURITY (audit 2026-07-15, CWE-532): the reset token is a 15m single-use
  // credential — logging it would let anyone with log access (DO runtime logs, a
  // SIEM/Sentry sink) complete an account takeover for any email, including admin
  // `user` actors. So the raw token is emitted ONLY in an EXPLICIT dev/test env,
  // where the log IS the dev mail transport. This is an allowlist (fail CLOSED),
  // mirroring modules/packs/topup.ts `mockTopupAllowed`: any other value —
  // production, prod, staging, or an unset/unexpected NODE_ENV — suppresses the
  // token, so a misconfigured deploy can never leak it. Wire a real notification
  // provider (Resend/SendGrid) before the storefront reset flow launches.
  const isDevOrTest =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

  // Only customers have a storefront reset page. Other actor types (admin
  // users reset via their own dashboards) still get the token logged so a
  // dev can complete the flow by hand — dev/test only.
  if (data.actor_type !== 'customer') {
    if (!isDevOrTest) {
      // TODO: deliver via the notification module for non-customer actors.
      logger.warn(
        `[password-reset] reset requested for ${data.actor_type} "${data.entity_id}" — delivery not configured (token not logged outside dev/test).`,
      );
      return;
    }
    logger.warn(
      `[password-reset] reset requested for ${data.actor_type} "${data.entity_id}" — no storefront page for this actor type; token: ${data.token}`,
    );
    return;
  }

  const base = (process.env.STOREFRONT_URL ?? 'http://localhost:4000').replace(
    /\/+$/,
    '',
  );
  const url = `${base}/reset-password?token=${encodeURIComponent(
    data.token,
  )}&email=${encodeURIComponent(data.entity_id)}`;

  if (!isDevOrTest) {
    // TODO: send `url` to `data.entity_id` via the notification module. Never
    // log the token/link outside dev/test.
    logger.warn(
      `[password-reset] reset requested for ${data.entity_id} — delivery not configured (link not logged outside dev/test).`,
    );
    return;
  }

  logger.warn(`[password-reset] reset link for ${data.entity_id}: ${url}`);
}

export const config: SubscriberConfig = {
  event: 'auth.password_reset',
};
