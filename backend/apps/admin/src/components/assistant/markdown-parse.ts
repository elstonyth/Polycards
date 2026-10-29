// The small Markdown subset the assistant writes (spec 2026-10-29):
// paragraphs, headings, lists, tables, code, bold, inline code and http(s)
// links. Parsed to plain data and rendered as React elements, never as HTML,
// and images are never rendered: model text cannot make the browser fetch
// anything (the chat shows only images the server stored).

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | {
      kind: 'table';
      head: string[];
      align: ('left' | 'right' | 'center' | null)[];
      rows: string[][];
    };

const INLINE =
  /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;

export function mdInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (t: Inline) => {
    const last = out.at(-1);
    if (t.kind === 'text' && last?.kind === 'text') last.text += t.text;
    else if (t.kind !== 'text' || t.text) out.push(t);
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    push({ kind: 'text', text: text.slice(at, start) });
    if (m[2] !== undefined) push({ kind: 'bold', text: m[2] });
    else if (m[4] !== undefined) push({ kind: 'code', text: m[4] });
    else if (text[start - 1] === '!') {
      // ![alt](url) is an image: kept as the text it is.
      push({ kind: 'text', text: m[0] });
    } else push({ kind: 'link', text: m[6], href: m[7] });
    at = start + m[0].length;
  }
  push({ kind: 'text', text: text.slice(at) });
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const BLOCK_START = /^(#{1,3}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/;

export function mdBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i++]);
      }
      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'h',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
      });
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && SEPARATOR.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : null,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(cells(lines[i++]));
      }
      blocks.push({ kind: 'table', head, align, rows });
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
    if (list) {
      const items: string[] = [];
      while (i < lines.length && list.test(lines[i])) {
        items.push(list.exec(lines[i++])![1]);
      }
      blocks.push({ kind: list === BULLET ? 'ul' : 'ol', items });
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}
