import { GET } from '../route';
import { accessFor } from '../../assistant/access';

// GET /admin/assistant-review with the assistant and user services faked:
// the search and staff filters, the voice sums and the super-admin gate.

jest.mock('../../assistant/access', () => ({ accessFor: jest.fn() }));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));

const accessMock = accessFor as jest.Mock;

function setup(messages: Record<string, unknown>[] = []) {
  const assistant = {
    listAndCountAssistantConversations: jest.fn(async (_filter: unknown) => [
      [
        {
          id: 'c1',
          title: 'Top hits',
          user_id: 'u1',
          last_message_at: new Date(),
          deleted_at: null,
        },
      ],
      1,
    ]),
    // With content: the search hits; without: the rows' stats.
    listAssistantMessages: jest.fn(async (filter: { content?: unknown }) =>
      filter.content
        ? [{ conversation_id: 'c9' }, { conversation_id: 'c9' }]
        : messages,
    ),
  };
  const users = {
    listUsers: jest.fn(async () => [{ id: 'u1', email: 'a@x.com' }]),
  };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const run = (query: Record<string, unknown>) =>
    GET(
      {
        query,
        scope: {
          resolve: (key: string) => (key === 'assistant' ? assistant : users),
        },
        auth_context: {},
      } as never,
      res as never,
    );
  return { assistant, res, run };
}

beforeEach(() => accessMock.mockReturnValue({ superAdmin: true }));

describe('GET /admin/assistant-review', () => {
  it('searches titles and message text, escaping % and _', async () => {
    const { assistant, run } = setup();
    await run({ q: ' 50%_off ' });
    const pattern = { $ilike: '%50\\%\\_off%' };
    expect(assistant.listAssistantMessages).toHaveBeenCalledWith(
      { content: pattern },
      { select: ['conversation_id'], withDeleted: true },
    );
    expect(
      assistant.listAndCountAssistantConversations.mock.calls[0][0],
    ).toEqual({ $or: [{ title: pattern }, { id: ['c9'] }] });
  });

  it('filters by one staff member, with no search pass', async () => {
    const { assistant, run } = setup();
    await run({ user_id: 'u1' });
    expect(
      assistant.listAndCountAssistantConversations.mock.calls[0][0],
    ).toEqual({ user_id: 'u1' });
    expect(assistant.listAssistantMessages).toHaveBeenCalledTimes(1);
  });

  it('sums voice rows apart from the total', async () => {
    const { res, run } = setup([
      { conversation_id: 'c1', role: 'user', cost_usd: 0 },
      { conversation_id: 'c1', role: 'assistant', cost_usd: 0.1, error: null },
      { conversation_id: 'c1', role: 'voice', cost_usd: 0.01 },
      { conversation_id: 'c1', role: 'voice', cost_usd: 0.02 },
    ]);
    await run({});
    const [row] = res.json.mock.calls[0][0].conversations;
    expect(row.questions).toBe(1);
    expect(row.read_aloud).toBe(2);
    expect(row.voice_cost_usd).toBeCloseTo(0.03);
    expect(row.cost_usd).toBeCloseTo(0.13);
    expect(row.user_email).toBe('a@x.com');
  });

  it('refuses anyone but a super admin', async () => {
    accessMock.mockReturnValue({ superAdmin: false });
    const { assistant, res, run } = setup();
    await run({});
    expect(res.status).toHaveBeenCalledWith(403);
    expect(assistant.listAndCountAssistantConversations).not.toHaveBeenCalled();
  });
});
