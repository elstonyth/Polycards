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

  it('keeps a ranked list counting across blank lines, with sub-points', () => {
    const [list, ...rest] = mdBlocks(
      '1. Ace\n   - RM 900\n\n2. Bo\n\n3. Cy\n\nDone.',
    );
    expect(list).toEqual({
      kind: 'ol',
      start: 1,
      items: [
        { text: 'Ace', sub: ['RM 900'] },
        { text: 'Bo', sub: [] },
        { text: 'Cy', sub: [] },
      ],
    });
    expect(rest).toEqual([{ kind: 'p', lines: ['Done.'] }]);
    expect(mdBlocks('4. four\n5. five')[0]).toMatchObject({ start: 4 });
  });

  it('starts a code block at an indented fence', () => {
    expect(mdBlocks('text\n  ```\ncode\n  ```').map((b) => b.kind)).toEqual([
      'p',
      'code',
    ]);
  });

  it('links only to our own site', () => {
    expect(mdInline('[x](https://evil.example/?d=secret)')).toEqual([
      { kind: 'text', text: '[x](https://evil.example/?d=secret)' },
    ]);
    expect(mdInline('[x](https://polycards.gg.evil.example/)')).toEqual([
      { kind: 'text', text: '[x](https://polycards.gg.evil.example/)' },
    ]);
    expect(mdInline('[x](https://evil.polycards.gg/?d=secret)')).toEqual([
      { kind: 'text', text: '[x](https://evil.polycards.gg/?d=secret)' },
    ]);
    expect(mdInline('[admin](https://admin.polycards.gg/x)')[0]).toMatchObject({
      kind: 'link',
    });
  });

  it('reads bold and inline code', () => {
    expect(mdInline('**RM 1,234** in `pull`')).toEqual([
      { kind: 'bold', text: 'RM 1,234' },
      { kind: 'text', text: ' in ' },
      { kind: 'code', text: 'pull' },
    ]);
  });
});
