import ResendNotificationProviderService from '../service';
import {
  BANK_ACCOUNT_ADDED_TEMPLATE,
  PASSWORD_RESET_TEMPLATE,
  PHONE_CHANGED_TEMPLATE,
  escapeHtml,
  renderTemplate,
} from '../templates';

// The `resend` SDK is mocked at the module boundary: these tests must never reach
// the network. The send spy is created INSIDE the factory (rather than closed over
// from the module scope) because jest hoists jest.mock above the surrounding
// declarations — a `const` referenced from the factory would be in its TDZ.
jest.mock('resend', () => {
  const send = jest.fn();
  return {
    Resend: jest.fn().mockImplementation(() => ({ emails: { send } })),
    __send: send,
  };
});

const { __send: send } = jest.requireMock('resend') as { __send: jest.Mock };

const TOKEN = 'super-secret-reset-jwt-token';
const URL = `https://polycards.gg/reset-password?token=${TOKEN}&email=victim%40example.com`;

function buildService(options?: { reply_to?: string }) {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const service = new ResendNotificationProviderService({ logger } as never, {
    api_key: 're_test_key',
    from: 'noreply@send.polycards.gg',
    ...options,
  });
  return { service, logger };
}

const notification = (overrides?: Record<string, unknown>) =>
  ({
    to: 'victim@example.com',
    channel: 'email',
    template: PASSWORD_RESET_TEMPLATE,
    data: { url: URL },
    ...overrides,
  }) as never;

beforeEach(() => {
  send.mockReset();
});

describe('ResendNotificationProviderService.validateOptions', () => {
  it.each(['api_key', 'from'])('throws when %s is missing', (key) => {
    const options: Record<string, unknown> = {
      api_key: 're_test_key',
      from: 'noreply@send.polycards.gg',
    };
    delete options[key];
    expect(() =>
      ResendNotificationProviderService.validateOptions(options),
    ).toThrow(key);
  });

  it('accepts a complete config', () => {
    expect(() =>
      ResendNotificationProviderService.validateOptions({
        api_key: 're_test_key',
        from: 'noreply@send.polycards.gg',
      }),
    ).not.toThrow();
  });
});

describe('ResendNotificationProviderService.send', () => {
  it('sends the rendered template and returns the Resend id', async () => {
    send.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const { service } = buildService();

    const result = await service.send(notification());

    expect(result).toEqual({ id: 'email_123' });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0];
    expect(sent.from).toBe('noreply@send.polycards.gg');
    expect(sent.to).toEqual(['victim@example.com']);
    expect(sent.subject).toContain('Reset your Polycards password');
    // Both parts are sent: a text alternative materially helps spam scoring on a
    // freshly-warmed sending domain.
    expect(sent.html).toContain('Reset password');
    expect(sent.text).toContain(URL);
  });

  it('omits replyTo when no reply_to is configured', async () => {
    send.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const { service } = buildService();

    await service.send(notification());

    expect(send.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it('sets replyTo when reply_to is configured', async () => {
    send.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const { service } = buildService({ reply_to: 'support@polycards.gg' });

    await service.send(notification());

    expect(send.mock.calls[0][0].replyTo).toBe('support@polycards.gg');
  });

  it('returns empty and skips the send for an unknown template', async () => {
    const { service, logger } = buildService();

    const result = await service.send(notification({ template: 'nope' }));

    expect(result).toEqual({});
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  // SECURITY (CWE-532), the same invariant subscribers/password-reset.ts enforces:
  // this error path runs in PRODUCTION, so it must never put the reset link — or the
  // single-use token inside it — into a log sink. Logging `notification` or
  // `notification.data` here would silently reintroduce the account-takeover leak
  // that the subscriber's dev/test gate exists to prevent.
  describe('never logs the reset token', () => {
    // Serialises OBJECT args rather than String()-ing them: the regression this
    // guards against is `logger.error(msg, notification.data)`, and String({url})
    // is "[object Object]" — which would sail past a naive substring check while
    // the token sat in the log. See the self-check at the bottom of this block.
    const serialiseLogArgs = (logger: { error: jest.Mock }) =>
      logger.error.mock.calls
        .flat()
        .map((arg) =>
          typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? ''),
        )
        .join('\n');

    const assertNoLeak = (logger: { error: jest.Mock }) => {
      const logged = serialiseLogArgs(logger);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(URL);
    };

    it('on a Resend API error', async () => {
      send.mockResolvedValue({
        data: null,
        error: { message: 'rate limited' },
      });
      const { service, logger } = buildService();

      await expect(service.send(notification())).rejects.toThrow();

      expect(logger.error).toHaveBeenCalled();
      assertNoLeak(logger);
    });

    it('on an unknown-error response', async () => {
      send.mockResolvedValue({ data: null, error: null });
      const { service, logger } = buildService();

      await expect(service.send(notification())).rejects.toThrow();

      assertNoLeak(logger);
    });

    // The thrown message is a second sink: @medusajs/notification wraps `e.message`
    // into its own MedusaError, which propagates out of the subscriber and gets
    // logged by the framework's error handler.
    it('in the message it throws on a Resend API error', async () => {
      send.mockResolvedValue({
        data: null,
        error: { message: 'rate limited' },
      });
      const { service } = buildService();

      await expect(service.send(notification())).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(TOKEN) as unknown as string,
        }),
      );
    });

    it('on an unrenderable template payload', async () => {
      const { service, logger } = buildService();

      await service.send(notification({ data: {} }));

      assertNoLeak(logger);
    });

    // Self-check: proves assertNoLeak can actually FAIL. Without this, the three
    // cases above would still pass if the assertion were blind to the regression
    // they exist to catch (an object arg carrying the reset link) — a green test
    // that cannot go red is not a guard. Exercises the assertion, not the service.
    it('the assertion itself catches a leak passed as an object arg', () => {
      const leaky = { error: jest.fn() };
      leaky.error('[resend] failed to send', { url: URL });

      expect(() => assertNoLeak(leaky)).toThrow();
    });
  });
});

describe('renderTemplate', () => {
  it('escapes HTML metacharacters so the href survives the query string', () => {
    const rendered = renderTemplate(PASSWORD_RESET_TEMPLATE, { url: URL })!;
    // `&` joining the token and email params must be `&amp;` inside an attribute.
    expect(rendered.html).toContain('&amp;email=');
    expect(rendered.html).not.toContain(`${TOKEN}&email=`);
    // The text part is not HTML — it carries the raw, unescaped URL.
    expect(rendered.text).toContain(`${TOKEN}&email=`);
  });

  it('returns undefined for an unknown template or a missing url', () => {
    expect(renderTemplate('nope', { url: URL })).toBeUndefined();
    expect(renderTemplate(PASSWORD_RESET_TEMPLATE, {})).toBeUndefined();
    expect(
      renderTemplate(PASSWORD_RESET_TEMPLATE, { url: '' }),
    ).toBeUndefined();
    expect(renderTemplate(PASSWORD_RESET_TEMPLATE, null)).toBeUndefined();
  });

  it('escapes every HTML metacharacter', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  // Pins the payload contract against store/phone-verification/change/route.ts,
  // which sends exactly these two keys. Nothing else would catch a drift: an
  // unrenderable payload makes `send` above log an error and record the
  // notification SUCCESS, so the phone-change security email would silently
  // stop going out with every suite still green.
  it('renders the phone-changed notice from the route’s exact payload', () => {
    const rendered = renderTemplate(PHONE_CHANGED_TEMPLATE, {
      old_phone_masked: '••••7781',
      new_phone_masked: '••••7790',
    })!;
    expect(rendered.html).toContain('••••7781');
    expect(rendered.html).toContain('••••7790');
    // The plaintext part is rendered independently of the HTML — assert BOTH
    // numbers there, or dropping the old one from the text body goes unnoticed.
    expect(rendered.text).toContain('••••7781');
    expect(rendered.text).toContain('••••7790');
  });

  it('refuses a phone-changed payload missing either number', () => {
    expect(
      renderTemplate(PHONE_CHANGED_TEMPLATE, { old_phone_masked: '••••7781' }),
    ).toBeUndefined();
    expect(
      renderTemplate(PHONE_CHANGED_TEMPLATE, { new_phone_masked: '••••7790' }),
    ).toBeUndefined();
    expect(renderTemplate(PHONE_CHANGED_TEMPLATE, null)).toBeUndefined();
  });

  // The bank-account-added alert reads `usable_from` and changes its promise on
  // it, because PAYOUT_DESTINATION_COOLDOWN_HOURS may be 0 (it is, in
  // production): with no waiting period left, an email still claiming "nothing
  // can be withdrawn to it before the time above" would be telling a customer
  // they have a reaction window they do not have. These three cases pin the
  // branch — there is no other coverage of this template's copy.
  const bankAccount = (usableFrom: string) =>
    renderTemplate(BANK_ACCOUNT_ADDED_TEMPLATE, {
      bank_name: 'Hong Leong Bank Berhad',
      account_last4: '3558',
      usable_from: usableFrom,
      site_url: 'https://polycards.gg',
    })!;

  it('says the account is payable right away when the wait is off', () => {
    const rendered = bankAccount(new Date(Date.now() - 1000).toISOString());

    expect(rendered.text).toContain('right away');
    expect(rendered.text).toContain('already be withdrawn to');
    expect(rendered.text).not.toContain('before the time above');
    // The "from <date>" row would print a timestamp already in the past.
    expect(rendered.html).not.toContain('Can be withdrawn to from');
    expect(rendered.html).toContain('already be withdrawn to');
  });

  it('still quotes the arming time while a wait is configured', () => {
    const rendered = bankAccount(
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );

    expect(rendered.text).toContain('It can receive withdrawals from ');
    expect(rendered.text).toContain('before the time above');
    expect(rendered.html).toContain('Can be withdrawn to from');
  });

  // Date.parse('') is NaN, and NaN <= now is false — an unreadable timestamp
  // must land on the CAUTIOUS branch rather than telling the owner the account
  // is already live. renderTemplate maps a missing usable_from to ''.
  it('treats an unreadable usable_from as still waiting', () => {
    const rendered = bankAccount('not-a-date');

    expect(rendered.text).toContain('after a short waiting period');
    expect(rendered.text).toContain('before the time above');
    expect(rendered.text).not.toContain('right away');
  });
});
