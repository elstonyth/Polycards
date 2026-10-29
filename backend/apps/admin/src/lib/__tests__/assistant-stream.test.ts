import { describe, expect, it } from 'vitest';
import { takeEvents } from '../assistant';
import { mdBlocks, mdInline } from '../../components/assistant/markdown-parse';

describe('takeEvents', () => {
  it('returns whole lines and keeps the unfinished tail', () => {
    const { events, rest } = takeEvents(
      '{"type":"text","delta":"Hi"}\n{"type":"ping"}\n{"type":"te',
    );
    expect(events).toEqual([{ type: 'text', delta: 'Hi' }, { type: 'ping' }]);
    expect(rest).toBe('{"type":"te');
  });

  it('joins an event split across two chunks', () => {
    const first = takeEvents('{"type":"text","de');
    const second = takeEvents(`${first.rest}lta":"lo"}\n`);
    expect(second.events).toEqual([{ type: 'text', delta: 'lo' }]);
  });

  it('drops a broken line instead of throwing', () => {
    expect(takeEvents('not json\n{"type":"ping"}\n').events).toEqual([
      { type: 'ping' },
    ]);
  });
});

describe('markdown', () => {
  it('reads a table, a list and paragraphs', () => {
    const blocks = mdBlocks(
      'Today:\n\n| Pack | Sold |\n|---|---:|\n| Silver | 12 |\n| Gold | 3 |\n\n- one\n- two',
    );
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'table', 'ul']);
    expect(blocks[1]).toMatchObject({
      head: ['Pack', 'Sold'],
      rows: [
        ['Silver', '12'],
        ['Gold', '3'],
      ],
      align: [null, 'right'],
    });
  });

  it('never turns markdown images into images, and links only http(s)', () => {
    expect(mdInline('![x](https://evil.example/a.png)')).toEqual([
      { kind: 'text', text: '![x](https://evil.example/a.png)' },
    ]);
    expect(mdInline('[a](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[a](javascript:alert(1))' },
    ]);
    expect(mdInline('see [docs](https://polycards.gg/task)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'docs', href: 'https://polycards.gg/task' },
    ]);
  });

  it('reads bold and inline code', () => {
    expect(mdInline('**RM 1,234** in `pull`')).toEqual([
      { kind: 'bold', text: 'RM 1,234' },
      { kind: 'text', text: ' in ' },
      { kind: 'code', text: 'pull' },
    ]);
  });
});
