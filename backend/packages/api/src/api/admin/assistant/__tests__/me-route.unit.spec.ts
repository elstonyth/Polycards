import { GET } from '../me/route';

// GET /admin/assistant/me with the assistant service faked: the header
// meter's numbers, today's spend against the daily cap.

jest.mock('../access', () => ({
  accessFor: () => ({ userId: 'user_1', superAdmin: false }),
  allowedTools: async () => [],
}));
jest.mock('../tools', () => ({ TOOLS: [] }));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));

const service = {
  // A float column can come back as a string; the route hands out a number.
  settings: jest.fn(async () => ({
    openrouter_key_sealed: 'sealed',
    chat_model: 'anthropic/claude-sonnet-5.5',
    daily_cap_usd: '5',
  })),
  spentToday: jest.fn(async () => 1.25),
};

it('returns today’s spend and the daily cap', async () => {
  const json = jest.fn();
  const req = { auth_context: {}, scope: { resolve: () => service } };
  await GET(req as never, { json } as never);
  expect(service.spentToday).toHaveBeenCalledWith('user_1');
  expect(json).toHaveBeenCalledWith(
    expect.objectContaining({ spent_today_usd: 1.25, daily_cap_usd: 5 }),
  );
});
