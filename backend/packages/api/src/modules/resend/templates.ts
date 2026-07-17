// Email bodies are plain HTML strings rather than React Email components: one
// transactional template doesn't justify pulling in the @react-email/* dependency
// tree. Swap to `react:` in the send options if the template count grows enough to
// make composition worth the deps.
//
// This file deliberately imports nothing from `resend` so the subscriber can import
// the template NAMES without dragging the SDK (and a constructed API client) into
// its module graph.

export const PASSWORD_RESET_TEMPLATE = 'password-reset';

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

// Returns undefined for an unknown template or missing/invalid data, letting the
// caller decide how to report it. `data` is Medusa's untyped notification payload,
// so the shape is validated here rather than trusted.
export const renderTemplate = (
  template: string,
  data: Record<string, unknown> | null | undefined,
): Rendered | undefined => {
  if (template !== PASSWORD_RESET_TEMPLATE) return undefined;
  const url = data?.url;
  if (typeof url !== 'string' || url.length === 0) return undefined;
  return passwordReset(url);
};
