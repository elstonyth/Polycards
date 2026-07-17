import { Modules } from '@medusajs/framework/utils';
import passwordResetHandler from '../password-reset';
import { PASSWORD_RESET_TEMPLATE } from '../../modules/resend/templates';

// SECURITY (audit 2026-07-15, CWE-532): the password-reset subscriber must NOT
// emit the single-use reset token to the logs unless it is running in an EXPLICIT
// dev/test env (log access would otherwise enable account takeover, incl. admin
// `user` actors). The gate is an allowlist (fail CLOSED): only NODE_ENV
// development/test log the token — production, prod, staging, or an unset/unknown
// value all suppress it, so a misconfigured deploy can't leak it.
//
// The token reaching Resend via createNotifications({ data: { url } }) is the POINT
// of the feature and is not a leak — it goes to the provider, not to a log sink.

type WarnArgs = string;

function buildHarness() {
  const warn = jest.fn<void, [WarnArgs]>();
  const error = jest.fn<void, [WarnArgs]>();
  const createNotifications = jest.fn().mockResolvedValue([]);
  const container = {
    resolve: (key: string) =>
      key === Modules.NOTIFICATION ? { createNotifications } : { warn, error },
  };
  return { warn, createNotifications, container };
}

const TOKEN = 'super-secret-reset-jwt-token';

async function run(
  container: { resolve: (k: string) => unknown },
  actor_type: string,
) {
  await passwordResetHandler({
    event: {
      data: { entity_id: 'victim@example.com', actor_type, token: TOKEN },
    },
    container,
    // The handler only uses event.data + container; the rest of SubscriberArgs
    // is irrelevant to this logic.
  } as unknown as Parameters<typeof passwordResetHandler>[0]);
}

describe('password-reset subscriber — token only logged in explicit dev/test', () => {
  const original = process.env.NODE_ENV;
  const originalResend = {
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
  };

  // Resend env is cleared by default so the existing cases below exercise the
  // "delivery not configured" path regardless of what the dev box has in .env —
  // otherwise a developer with real credentials would silently run different tests.
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  afterEach(() => {
    process.env.NODE_ENV = original;
    if (originalResend.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResend.key;
    if (originalResend.from === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = originalResend.from;
  });

  it.each(['production', 'prod'])(
    'NODE_ENV=%s: customer reset never logs the token/link',
    async (env) => {
      process.env.NODE_ENV = env;
      const { warn, container } = buildHarness();
      await run(container, 'customer');
      const logged = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).not.toContain(TOKEN);
    },
  );

  it.each(['production', 'prod'])(
    'NODE_ENV=%s: admin/user reset never logs the token',
    async (env) => {
      process.env.NODE_ENV = env;
      const { warn, container } = buildHarness();
      await run(container, 'user');
      const logged = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).not.toContain(TOKEN);
    },
  );

  it.each(['development', 'test'])(
    'NODE_ENV=%s: customer reset DOES log the link (dev mail transport)',
    async (env) => {
      process.env.NODE_ENV = env;
      const { warn, container } = buildHarness();
      await run(container, 'customer');
      const logged = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).toContain(TOKEN);
    },
  );

  it.each(['development', 'test'])(
    'NODE_ENV=%s: admin/user reset DOES log the token (dev mail transport)',
    async (env) => {
      process.env.NODE_ENV = env;
      const { warn, container } = buildHarness();
      await run(container, 'user');
      const logged = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).toContain(TOKEN);
    },
  );

  // Fail-closed: an unexpected or unset NODE_ENV must NOT log the token — the
  // gate is an allowlist, not a `production` denylist. Covers both actor types.
  it.each([
    ['staging', 'customer'],
    ['staging', 'user'],
    [undefined, 'customer'],
    [undefined, 'user'],
  ])(
    'NODE_ENV=%s, actor=%s: unexpected/unset env never logs the token',
    async (env, actor) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      const { warn, container } = buildHarness();
      await run(container, actor as string);
      const logged = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).not.toContain(TOKEN);
    },
  );
});

describe('password-reset subscriber — email delivery', () => {
  const original = process.env.NODE_ENV;
  const originalResend = {
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
  };

  afterEach(() => {
    process.env.NODE_ENV = original;
    if (originalResend.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResend.key;
    if (originalResend.from === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = originalResend.from;
  });

  const configureResend = () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@send.polycards.gg';
  };

  it('production + Resend configured: sends the reset link on the email channel', async () => {
    process.env.NODE_ENV = 'production';
    configureResend();
    const { createNotifications, container } = buildHarness();

    await run(container, 'customer');

    expect(createNotifications).toHaveBeenCalledTimes(1);
    expect(createNotifications).toHaveBeenCalledWith({
      to: 'victim@example.com',
      channel: 'email',
      template: PASSWORD_RESET_TEMPLATE,
      data: { url: expect.stringContaining(encodeURIComponent(TOKEN)) },
    });
  });

  it('production + Resend configured: still keeps the token out of the logs', async () => {
    process.env.NODE_ENV = 'production';
    configureResend();
    const { warn, container } = buildHarness();

    await run(container, 'customer');

    const logged = warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).not.toContain(TOKEN);
  });

  // The gate is shared with medusa-config.ts, which registers NO email provider on a
  // partial config. If the subscriber gated on api_key alone it would call
  // createNotifications({ channel: 'email' }) with nothing registered, and the
  // notification module throws MedusaError.NOT_FOUND from inside the event handler.
  it('production + partial Resend config (no from): warns instead of sending', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.RESEND_FROM_EMAIL;
    const { warn, createNotifications, container } = buildHarness();

    await run(container, 'customer');

    expect(createNotifications).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('not configured');
    expect(logged).not.toContain(TOKEN);
  });

  // A dev box holding real credentials must not send live mail — the console link
  // stays the dev transport, so a fresh sending domain never burns reputation (or
  // quota) on development traffic.
  it.each(['development', 'test'])(
    'NODE_ENV=%s + Resend configured: logs the link and sends nothing',
    async (env) => {
      process.env.NODE_ENV = env;
      configureResend();
      const { warn, createNotifications, container } = buildHarness();

      await run(container, 'customer');

      expect(createNotifications).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).toContain(TOKEN);
    },
  );
});
