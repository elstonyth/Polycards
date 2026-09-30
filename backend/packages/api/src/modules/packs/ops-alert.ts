// Operator alerts, posted to a PRIVATE Telegram chat. Never the apex-pull
// board's channel (TELEGRAM_CHAT_ID): that one is public, and "our payout
// wallet is empty" is the last thing it should announce. Same bot, own chat:
//   TELEGRAM_BOT_TOKEN    shared with telegram.ts.
//   TELEGRAM_OPS_CHAT_ID  a private group the bot has been added to. Unset ->
//                         the alert is only the log line below.
//
// A few lines of fetch rather than telegram.ts's callTelegram: that module
// loads sharp and the pull-card renderer, which the payout path must not pull
// into its import graph.

type Logger = {
  error: (message: string) => void;
  warn: (message: string) => void;
};

type Scope = { resolve: <T>(key: string) => T };

/** One alert per window, however many customers retry into the empty wallet. */
export const PAYOUT_FLOAT_ALERT_EVERY_MS = 30 * 60_000;

let lastPayoutFloatAlertAt = -Infinity;

/** Test seam: module state outlives a test (one jest process is one module
 *  instance), same reason as resetTelegramWarnings. */
export function resetOpsAlerts(): void {
  lastPayoutFloatAlertAt = -Infinity;
}

/**
 * Log `text` under a stable `[ops-alert] <tag>:` marker and post it to the ops
 * chat. Never throws and never rejects; `onSendFailed` runs if Telegram does
 * not take it (after it has been logged).
 */
function postOpsAlert(
  scope: Scope,
  tag: string,
  text: string,
  onSendFailed?: () => void,
): Promise<void> {
  try {
    const logger = scope.resolve<Logger>('logger');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_OPS_CHAT_ID?.trim();
    const sendable =
      Boolean(token && chatId) &&
      chatId !== process.env.TELEGRAM_CHAT_ID?.trim();
    // Started before the log line, so a logger that throws cannot cost the send.
    const sent = !sendable
      ? Promise.resolve()
      : fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(10_000),
        })
          .then(async (res) => {
            const body = (await res.json()) as {
              ok?: boolean;
              description?: string;
            };
            if (!body.ok) {
              throw new Error(body.description ?? `HTTP ${res.status}`);
            }
          })
          .catch((error: unknown) => {
            onSendFailed?.();
            try {
              logger.warn(
                `[ops-alert] Telegram did not take the ${tag} alert: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            } catch {
              // The logger is what failed; nothing left to report it with.
            }
          });
    // Stable marker for a log-based alert rule; do not reword casually.
    logger.error(
      `[ops-alert] ${tag}: ${text}` +
        (sendable
          ? ''
          : ' (not sent to Telegram: TELEGRAM_OPS_CHAT_ID is unset or is the public TELEGRAM_CHAT_ID)'),
    );
    return sent;
  } catch {
    return Promise.resolve();
  }
}

/**
 * Tell ops that TGPay refused a payout because OUR payout wallet is short
 * (TGPAY_PAYOUT_FLOAT_EMPTY). On 2026-09-06 and 2026-09-29 that went unnoticed
 * until a customer complained, after 8 and 9 refused attempts.
 *
 * Never throws and never rejects: callers fire it without awaiting, after the
 * refund has committed, so the customer's answer does not wait on Telegram.
 * Carries our reference and the amount only — never the account number or the
 * holder name.
 */
export function alertPayoutFloatEmpty(
  scope: Scope,
  detail: { amount: number; ref: string; via: string },
): Promise<void> {
  const now = Date.now();
  if (now - lastPayoutFloatAlertAt < PAYOUT_FLOAT_ALERT_EVERY_MS) {
    return Promise.resolve();
  }
  // Stamped before the send, so a burst arriving together cannot all pass.
  // ponytail: per-process, and the web service runs 2 instances, so a burst
  // can alert twice. A Redis SET NX key if that ever matters.
  lastPayoutFloatAlertAt = now;
  const text =
    `TGPay payout wallet is short: payouts are being refused with ` +
    `"Insufficient payout credit balance". Latest: RM ${detail.amount} ` +
    `(${detail.ref}, ${detail.via}), refunded to the customer. Every payout ` +
    `fails until the TGPay payout wallet is topped up. Repeats muted for ` +
    `${PAYOUT_FLOAT_ALERT_EVERY_MS / 60_000} min.`;
  // Unmuted on a failed send, so the next refusal tries again instead of the
  // window passing in silence.
  return postOpsAlert(scope, 'payout-float-empty', text, () => {
    lastPayoutFloatAlertAt = -Infinity;
  });
}

/**
 * A rare, must-see event (e.g. TGPay says it paid a payout we already
 * refunded). Not muted: every occurrence is its own investigation. Same
 * guarantees as alertPayoutFloatEmpty — never throws, never rejects, and the
 * caller must not put account numbers or names in `text`.
 */
export function alertOps(
  scope: Scope,
  tag: string,
  text: string,
): Promise<void> {
  return postOpsAlert(scope, tag, text);
}
