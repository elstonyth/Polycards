import {
  AbstractNotificationProviderService,
  MedusaError,
} from '@medusajs/framework/utils';
import type {
  Logger,
  ProviderSendNotificationDTO,
  ProviderSendNotificationResultsDTO,
} from '@medusajs/framework/types';
import { Resend } from 'resend';
import { renderTemplate } from './templates';

export type ResendOptions = {
  api_key: string;
  from: string;
  reply_to?: string;
};

type InjectedDependencies = { logger: Logger };

class ResendNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = 'notification-resend';

  private readonly resendClient: Resend;
  private readonly options: ResendOptions;
  private readonly logger: Logger;

  constructor({ logger }: InjectedDependencies, options: ResendOptions) {
    super();
    this.resendClient = new Resend(options.api_key);
    this.options = options;
    this.logger = logger;
  }

  // Runs at module registration. medusa-config.ts only registers this provider when
  // isResendConfigured() passes (both api_key and from present), so in practice this
  // is a second line of defence rather than the primary gate — but it keeps the
  // provider honest if it is ever registered from somewhere else.
  static validateOptions(options: Record<string, unknown>): void {
    for (const key of ['api_key', 'from'] as const) {
      if (!options[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Resend notification provider requires \`${key}\` in its options.`,
        );
      }
    }
  }

  async send(
    notification: ProviderSendNotificationDTO,
  ): Promise<ProviderSendNotificationResultsDTO> {
    const rendered = renderTemplate(
      notification.template,
      notification.data as Record<string, unknown> | undefined,
    );

    if (!rendered) {
      // PERMANENT failure — an unknown template or a malformed payload, i.e. a code
      // bug, not a runtime condition. Returns instead of throwing so that IF the
      // global event-bus `attempts` is ever raised (see the note on the error path
      // below), redelivery isn't spent on something that cannot succeed. The tradeoff
      // is that this records status SUCCESS for an email that was never sent; the
      // logged error is the real signal. Names the template only — see the SECURITY
      // note below.
      this.logger.error(
        `[resend] no renderable email template named "${notification.template}"`,
      );
      return {};
    }

    const { data, error } = await this.resendClient.emails.send({
      from: this.options.from,
      to: [notification.to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(this.options.reply_to ? { replyTo: this.options.reply_to } : {}),
    });

    if (error || !data) {
      // SECURITY (CWE-532, same invariant as subscribers/password-reset.ts): the
      // message carries the template name and Resend's error ONLY. Never include
      // `notification` or `notification.data` — the password-reset payload holds the
      // single-use reset link, this path runs in PRODUCTION, and the message below is
      // both logged and wrapped into the thrown MedusaError. That is exactly what the
      // subscriber's dev/test gate exists to keep out of the logs; anyone with log
      // access could otherwise complete an account takeover.
      const message = `[resend] failed to send "${notification.template}": ${
        error?.message ?? 'unknown error'
      }`;
      this.logger.error(message);

      // Throw rather than return so the notification row records status FAILURE:
      // @medusajs/notification only runs its failure branch when the provider THROWS
      // (notification-module-service.js:95); a plain return falls through to
      // `status = SUCCESS` with an undefined external_id, i.e. a Resend outage would
      // be recorded as a delivered email.
      //
      // NOTE — this does NOT cause a retry, and nothing here redelivers the email.
      // core-flows emits auth.password_reset via emitEventStep({eventName, data}) with
      // no `attempts` option, so event-bus-redis buildEvents defaults attempts:1; its
      // worker gates redelivery on `isRetriesConfigured = configuredAttempts > 1`
      // (event-bus-redis.js:81-83), which is false, and it merely warns "Retrying is
      // not configured". A transient failure therefore loses that email permanently —
      // the customer must request a new reset. Recording FAILURE instead of a false
      // SUCCESS is the whole benefit, and it is why the throw stays.
      //
      // Making delivery durable would mean setting eventBusRedisJobOptions.attempts>1
      // in medusa-config.ts, which is GLOBAL to every event in the app — deliberately
      // out of scope here. It would also need an idempotency_key, since the module
      // only reprocesses FAILURE rows when one is present
      // (notification-module-service.js:51-55).
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message);
    }

    return { id: data.id };
  }
}

export default ResendNotificationProviderService;
