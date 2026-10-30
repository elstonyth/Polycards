import { messageView } from '../views';

const row = {
  id: 'm',
  role: 'assistant',
  attachments: 0,
  images: null,
  tools: null,
  error: null,
  cost_usd: 0,
  created_at: '2026-10-30',
};

describe('messageView', () => {
  it('hides tool calls a model wrote as text in an answer already saved', () => {
    expect(
      messageView({
        ...row,
        content: 'RM 0 <｜DSML｜ calls>SELECT 1</｜DSML｜ calls>',
      }).content,
    ).toBe('RM 0 ');
  });

  it('leaves a normal answer alone', () => {
    expect(messageView({ ...row, content: 'A < B' }).content).toBe('A < B');
  });
});
