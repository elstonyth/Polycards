import {
  alertPayoutFloatEmpty,
  PAYOUT_FLOAT_ALERT_EVERY_MS,
  resetOpsAlerts,
} from '../ops-alert';

// The alert that was missing on 2026-09-06 and 2026-09-29: our TGPay payout
// wallet ran dry, and customers found out before anyone on our side did.

const detail = { amount: 150, ref: 'PC-w1', via: 'customer withdrawal' };

function harness() {
  const logger = { error: jest.fn(), warn: jest.fn() };
  const sent: { url: string; body: { chat_id: string; text: string } }[] = [];
  const fetchMock = jest.fn(async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return {
    logger,
    sent,
    fetchMock,
    scope: { resolve: () => logger } as never,
  };
}

const ORIGINAL_ENV = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
  resetOpsAlerts();
  process.env.TELEGRAM_BOT_TOKEN = 'bot-test';
  process.env.TELEGRAM_OPS_CHAT_ID = '-100ops';
  process.env.TELEGRAM_CHAT_ID = '-100public';
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = originalFetch;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

it('posts to the private ops chat once per window, however many refusals land in it', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const h = harness();
  // Nine retries in 45 minutes was the 2026-09-29 burst: one alert, not nine.
  for (let i = 0; i < 9; i++) await alertPayoutFloatEmpty(h.scope, detail);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].url).toBe(
    'https://api.telegram.org/botbot-test/sendMessage',
  );
  expect(h.sent[0].body.chat_id).toBe('-100ops');
  expect(h.sent[0].body.text).toMatch(/payout wallet/i);
  expect(h.sent[0].body.text).toMatch(/RM 150/);
  expect(h.sent[0].body.text).toMatch(/PC-w1/);

  // Still empty after the window: say so again.
  now.mockReturnValue(1_000_000 + PAYOUT_FLOAT_ALERT_EVERY_MS);
  await alertPayoutFloatEmpty(h.scope, detail);
  expect(h.sent).toHaveLength(2);
});

it('mutes per gateway: TGPay going quiet does not silence The 7 Pay', async () => {
  const h = harness();
  await alertPayoutFloatEmpty(h.scope, { ...detail, gateway: 'TGPay' });
  await alertPayoutFloatEmpty(h.scope, { ...detail, gateway: 'TGPay' });
  await alertPayoutFloatEmpty(h.scope, { ...detail, gateway: 'The 7 Pay' });
  expect(h.sent).toHaveLength(2);
});

it('logs a greppable line and sends nothing when no ops chat is configured', async () => {
  delete process.env.TELEGRAM_OPS_CHAT_ID;
  const h = harness();
  await alertPayoutFloatEmpty(h.scope, detail);
  expect(h.fetchMock).not.toHaveBeenCalled();
  expect(h.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('[ops-alert] payout-float-empty'),
  );
});

it('never posts to the public apex-pull channel, even when pointed at it', async () => {
  // "Our payout wallet is empty" is the last thing the public channel
  // should announce.
  process.env.TELEGRAM_OPS_CHAT_ID = '-100public';
  const h = harness();
  await alertPayoutFloatEmpty(h.scope, detail);
  expect(h.fetchMock).not.toHaveBeenCalled();
});

it('a failed send is retried by the next refusal instead of muting the window', async () => {
  const h = harness();
  h.fetchMock
    .mockRejectedValueOnce(new Error('ETIMEDOUT'))
    .mockResolvedValueOnce({
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    });
  await expect(alertPayoutFloatEmpty(h.scope, detail)).resolves.toBeUndefined();
  expect(h.logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('ETIMEDOUT'),
  );
  // Telegram answering ok:false is a failure too, not a delivery.
  await alertPayoutFloatEmpty(h.scope, detail);
  expect(h.logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('chat not found'),
  );
  await alertPayoutFloatEmpty(h.scope, detail);
  expect(h.fetchMock).toHaveBeenCalledTimes(3);
});

it('a logger that throws does not cost the send', async () => {
  const h = harness();
  h.logger.error.mockImplementation(() => {
    throw new Error('logger exploded');
  });
  await expect(
    alertPayoutFloatEmpty(h.scope, detail),
  ).resolves.toBeUndefined();
  expect(h.sent).toHaveLength(1);
});

it('never throws or rejects into the money path, even with a broken logger', async () => {
  harness();
  const scope = {
    resolve: () => {
      throw new Error('no logger');
    },
  } as never;
  await expect(alertPayoutFloatEmpty(scope, detail)).resolves.toBeUndefined();
});
