// Email bodies are plain HTML strings rather than React Email components: one
// transactional template doesn't justify pulling in the @react-email/* dependency
// tree. Swap to `react:` in the send options if the template count grows enough to
// make composition worth the deps.
//
// This file deliberately imports nothing from `resend` so the subscriber can import
// the template NAMES without dragging the SDK (and a constructed API client) into
// its module graph.

export const PASSWORD_RESET_TEMPLATE = 'password-reset';
export const TOPUP_RECEIPT_TEMPLATE = 'topup-receipt';

export type Rendered = { subject: string; html: string; text: string };

// The reset URL is interpolated into an href. Its query string joins params with
// `&`, which must become `&amp;` inside an HTML attribute; the token/email values
// are already percent-encoded by the caller, but escaping the full set of HTML
// metacharacters keeps this correct even if the URL shape changes later.
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const passwordReset = (url: string): Rendered => {
  const href = escapeHtml(url);
  return {
    subject: 'Reset your Polycards password',
    text: [
      'Reset your Polycards password',
      '',
      'Someone asked to reset the password for this Polycards account. Open the',
      'link below to choose a new one. It expires in 15 minutes and works once.',
      '',
      url,
      '',
      "If this wasn't you, ignore this email — your password stays unchanged.",
    ].join('\n'),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#171717;">
    <div style="max-width:520px;margin:0 auto;padding:40px 24px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#fafafa;">
      <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.01em;">Reset your password</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#d4d4d4;">
        Someone asked to reset the password for this Polycards account. Choose a new
        one using the button below — the link expires in 15 minutes and works only once.
      </p>
      <a href="${href}" style="display:inline-block;padding:12px 24px;border-radius:9999px;background:#fafafa;color:#171717;font-size:15px;font-weight:700;text-decoration:none;">Reset password</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#a3a3a3;">
        If this wasn't you, ignore this email and your password stays unchanged.
      </p>
      <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#737373;word-break:break-all;">
        Button not working? Paste this into your browser:<br />${href}
      </p>
    </div>
  </body>
</html>`,
  };
};

// Money as the customer reads it: "RM 1,234.50". Always 2dp — a receipt that
// says "RM 50" for RM 50.00 reads like a rounded figure rather than the exact
// amount that left their bank.
const rm = (value: number): string =>
  `RM ${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// The date the money settled, in Malaysia time — every customer and every
// amount here is MYR, so UTC would just invite "why does it say yesterday".
// Fixed +8h, correct because Asia/Kuala_Lumpur has never observed DST (the same
// reasoning as modules/packs/ledger.ts ymqInMyt).
const settledAt = (iso: string): string => {
  const d = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} (MYT)`;
};

// What the customer sees instead of the gateway's method code.
const METHOD_LABEL: Record<string, string> = {
  OB: 'Online banking',
  BQR: 'QR / e-wallet',
  FPX: 'FPX',
  DN: 'DuitNow',
};

type ReceiptData = {
  amount: number;
  reference: string;
  method: string;
  occurredAt: string;
  siteUrl: string;
};

// One row of the receipt table. Tables (not flex/grid) because Outlook still
// renders neither, and inline styles because every mail client strips <style>.
const row = (label: string, value: string, strong = false): string =>
  `<tr>
        <td style="padding:10px 0;font-size:14px;color:#a3a3a3;">${escapeHtml(label)}</td>
        <td style="padding:10px 0;font-size:14px;text-align:right;color:${
          strong ? '#fafafa' : '#d4d4d4'
        };font-weight:${strong ? '700' : '400'};">${escapeHtml(value)}</td>
      </tr>`;

const topupReceipt = (d: ReceiptData): Rendered => {
  const amount = rm(d.amount);
  const when = settledAt(d.occurredAt);
  const method = METHOD_LABEL[d.method] ?? d.method;
  const site = escapeHtml(d.siteUrl.replace(/\/+$/, ''));
  const logo = `${site}/branding/polycards-logo.png`;

  return {
    subject: `Your ${amount} top-up is in — Polycards`,
    text: [
      `Thank you for topping up.`,
      '',
      `${amount} has been added to your Polycards balance and is ready to spend.`,
      '',
      `Amount:     ${amount}`,
      `Method:     ${method}`,
      `Reference:  ${d.reference}`,
      when ? `Date:       ${when}` : '',
      '',
      `See it in your history: ${d.siteUrl.replace(/\/+$/, '')}/transactions`,
      '',
      'Keep this email for your records.',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#171717;">
    <div style="max-width:520px;margin:0 auto;padding:40px 24px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#fafafa;">
      <img src="${logo}" alt="Polycards" width="150" style="display:block;width:150px;max-width:60%;height:auto;margin:0 0 32px;" />

      <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#a3a3a3;">Top-up received</p>
      <h1 style="margin:0 0 8px;font-size:40px;line-height:1.1;font-weight:800;letter-spacing:-0.02em;">${escapeHtml(amount)}</h1>
      <p style="margin:0 0 32px;font-size:15px;line-height:1.6;color:#d4d4d4;">
        Thank you for topping up — it's in your balance and ready to spend.
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;border-top:1px solid #404040;border-bottom:1px solid #404040;margin:0 0 32px;">
        ${row('Amount', amount, true)}
        ${row('Payment method', method)}
        ${row('Reference', d.reference)}
        ${when ? row('Date', when) : ''}
      </table>

      <a href="${site}/transactions" style="display:inline-block;padding:12px 24px;border-radius:9999px;background:#fafafa;color:#171717;font-size:15px;font-weight:700;text-decoration:none;">View your history</a>

      <p style="margin:32px 0 0;font-size:12px;line-height:1.6;color:#737373;">
        Keep this email for your records. Questions about this payment? Reply to
        this email and quote the reference above.
      </p>
    </div>
  </body>
</html>`,
  };
};

// Returns undefined for an unknown template or missing/invalid data, letting the
// caller decide how to report it. `data` is Medusa's untyped notification payload,
// so the shape is validated here rather than trusted.
export const renderTemplate = (
  template: string,
  data: Record<string, unknown> | null | undefined,
): Rendered | undefined => {
  if (template === PASSWORD_RESET_TEMPLATE) {
    const url = data?.url;
    if (typeof url !== 'string' || url.length === 0) return undefined;
    return passwordReset(url);
  }

  if (template === TOPUP_RECEIPT_TEMPLATE) {
    const amount = data?.amount_myr;
    const reference = data?.reference;
    const method = data?.payment_method;
    const occurredAt = data?.occurred_at;
    const siteUrl = data?.site_url;
    // A receipt with a missing amount or reference is worse than no receipt —
    // it tells the customer money moved without saying how much or letting
    // support trace it. Fail closed and let the caller log it.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return undefined;
    }
    if (typeof reference !== 'string' || reference.length === 0) {
      return undefined;
    }
    if (typeof siteUrl !== 'string' || siteUrl.length === 0) return undefined;
    return topupReceipt({
      amount,
      reference,
      method: typeof method === 'string' ? method : '',
      occurredAt: typeof occurredAt === 'string' ? occurredAt : '',
      siteUrl,
    });
  }

  return undefined;
};
