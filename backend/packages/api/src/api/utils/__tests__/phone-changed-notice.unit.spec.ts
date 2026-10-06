import { Modules } from '@medusajs/framework/utils';
import { sendPhoneChangedNotice } from '../phone-changed-notice';
import { PHONE_CHANGED_TEMPLATE } from '../../../modules/resend/templates';

const EMAIL = 'owner@test.dev';
const OLD_PHONE = '+60107667781';
const NEW_PHONE = '+60107667790';

const createNotifications = jest.fn(
  async (_payload: Record<string, unknown>) => [],
);
const warn = jest.fn();
const scope = {
  resolve: (key: string) => {
    if (key === Modules.NOTIFICATION) return { createNotifications };
    if (key === 'logger') return { warn };
    throw new Error(`unexpected resolve('${key}')`);
  },
} as never;

const ORIGINAL_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
};

beforeEach(() => {
  jest.clearAllMocks();
  // The helper sends nothing unless Resend is configured.
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM_EMAIL = 'no-reply@test.dev';
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const send = (oldPhone: string | null) =>
  sendPhoneChangedNotice(scope, {
    to: EMAIL,
    customerId: 'cus_1',
    oldPhone,
    newPhone: NEW_PHONE,
    logTag: 'admin-phone-change',
  });

describe('sendPhoneChangedNotice', () => {
  it('emails the account with only the last 4 digits of either number', async () => {
    await send(OLD_PHONE);
    expect(createNotifications.mock.calls[0][0]).toEqual({
      to: EMAIL,
      channel: 'email',
      template: PHONE_CHANGED_TEMPLATE,
      data: { old_phone_masked: '••••7781', new_phone_masked: '••••7790' },
    });
  });

  it('names a first-time number as "no number" rather than skipping the notice', async () => {
    await send(null);
    expect(createNotifications.mock.calls[0][0]).toMatchObject({
      data: { old_phone_masked: 'no number', new_phone_masked: '••••7790' },
    });
  });

  it('sends nothing when Resend is not configured', async () => {
    delete process.env.RESEND_API_KEY;
    await send(OLD_PHONE);
    expect(createNotifications.mock.calls.length).toBe(0);
    expect(warn.mock.calls.length).toBe(0);
  });

  // The phone already moved: a dropped notice must not throw, and the warn
  // must not leak the numbers or the address — the provider's own error text
  // names the recipient, which is why it is never interpolated.
  it('never throws, and logs the customer id only', async () => {
    createNotifications.mockRejectedValueOnce(
      new Error(`resend is down: failed to deliver to ${EMAIL}`),
    );
    await expect(send(OLD_PHONE)).resolves.toBeUndefined();
    expect(warn.mock.calls.length).toBe(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('cus_1');
    expect(logged).toContain('[admin-phone-change]');
    expect(logged).not.toContain(OLD_PHONE);
    expect(logged).not.toContain(NEW_PHONE);
    expect(logged).not.toContain(EMAIL);
  });
});
