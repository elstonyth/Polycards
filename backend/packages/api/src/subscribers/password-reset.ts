import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { Modules } from '@medusajs/framework/utils';
import type { INotificationModuleService } from '@medusajs/framework/types';
import { isResendConfigured } from '../modules/resend/options';
import { PASSWORD_RESET_TEMPLATE } from '../modules/resend/templates';

// Delivery for the forgot-password flow. In production the reset link is emailed via
// the notification module's `email` channel (Resend — see src/modules/resend); in
// dev/test the link is logged at WARN instead, so the console stays the local mail
// transport and a fresh sending domain never burns reputation on dev traffic.
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
  // token, so a misconfigured deploy can never leak it.
  const isDevOrTest =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

  // Only customers have a storefront reset page. Other actor types (admin
  // users reset via their own dashboards) still get the token logged so a
  // dev can complete the flow by hand — dev/test only.
  if (data.actor_type !== 'customer') {
    if (!isDevOrTest) {
      // TODO: deliver via the notification module for non-customer actors once the
      // admin/vendor dashboards have a reset page to link to.
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

  // Dev/test: the log is the mail transport. Deliberately checked BEFORE the Resend
  // gate so a developer with real credentials in .env still gets the console link
  // rather than sending live email from a dev box.
  if (isDevOrTest) {
    logger.warn(`[password-reset] reset link for ${data.entity_id}: ${url}`);
    return;
  }

  // Shares medusa-config.ts's exact predicate: when this is false no provider is
  // registered on the `email` channel, and createNotifications would throw
  // MedusaError.NOT_FOUND from inside this handler instead of warning cleanly.
  if (!isResendConfigured(process.env)) {
    logger.warn(
      `[password-reset] reset requested for ${data.entity_id} — email delivery not configured (link not logged outside dev/test).`,
    );
    return;
  }

  const notificationModuleService: INotificationModuleService =
    container.resolve(Modules.NOTIFICATION);

  // Left to throw on failure: the event bus retries a rejected subscriber, which is
  // what a transient Resend outage wants. The provider itself swallows send errors
  // (logging the template name only), so nothing here can put the token in a log.
  await notificationModuleService.createNotifications({
    to: data.entity_id,
    channel: 'email',
    template: PASSWORD_RESET_TEMPLATE,
    data: { url },
  });
}

export const config: SubscriberConfig = {
  event: 'auth.password_reset',
};
