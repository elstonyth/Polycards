import passwordResetHandler from '../password-reset';

// SECURITY (audit 2026-07-15, CWE-532): the password-reset subscriber must NOT
// emit the single-use reset token to the logs unless it is running in an EXPLICIT
// dev/test env (log access would otherwise enable account takeover, incl. admin
// `user` actors). The gate is an allowlist (fail CLOSED): only NODE_ENV
// development/test log the token — production, prod, staging, or an unset/unknown
// value all suppress it, so a misconfigured deploy can't leak it.

type WarnArgs = string;

function buildHarness() {
  const warn = jest.fn<void, [WarnArgs]>();
  const container = { resolve: (_key: string) => ({ warn }) };
  return { warn, container };
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
  afterEach(() => {
    process.env.NODE_ENV = original;
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
