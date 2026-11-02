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
  | {
      kind: 'ul' | 'ol';
      start: number;
      items: { text: string; sub: string[] }[];
    }
  | { kind: 'code'; text: string }
  | {
      kind: 'table';
      head: string[];
      align: ('left' | 'right' | 'center' | null)[];
      rows: string[][];
    };

// Bounded repeats: an unclosed [ or ** repeated thousands of times in an
// answer (planted in data the model read) would otherwise take quadratic
// time on every streamed chunk and freeze the tab.
const INLINE =
  /(\*\*([^*]{1,500})\*\*)|(`([^`]{1,500})`)|(\[([^\]]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\))/g;

/** polycards.gg, www or admin, over http(s): no other subdomain is ours. */
const ownSite = (href: string): boolean => {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return ['polycards.gg', 'www.polycards.gg', 'admin.polycards.gg'].includes(
      host,
    );
  } catch {
    return false;
  }
};

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
    else if (text[start - 1] === '!' || !ownSite(m[7])) {
      // ![alt](url) is an image, and a link off our own site could carry
      // customer data out in its query (text a customer typed can steer the
      // model): both stay the text they are.
      push({ kind: 'text', text: m[0] });
    } else push({ kind: 'link', text: m[6], href: m[7] });
    at = start + m[0].length;
  }
  push({ kind: 'text', text: text.slice(at) });
  return out;
}

// A row splits on "|", but not on an escaped \| (read as "|") or one inside
// a closed `code` span.
const cells = (line: string) => {
  const row = [''];
  const body = line.trim().replace(/^\|/, '');
  for (const [part] of body.matchAll(/`[^`]*`|\\\||[\s\S]/g)) {
    if (part === '|') row.push('');
    else row[row.length - 1] += part.replace(/\\\|/g, '|');
  }
  // The closing "|" leaves an empty last cell.
  if (row.length > 1 && row.at(-1) === '') row.pop();
  return row.map((c) => c.trim());
};

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const BLOCK_START = /^(#{1,3}\s|\s*```|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/;
const indent = (l: string) => /^\s*/.exec(l)![0].length;
const isRow = (l: string | undefined) => !!l?.trim().startsWith('|');

// An amount, count or percentage: RM 1,234.50, -RM 12, S$30, 12.5%, 3k.
const NUMBER_CELL = /^[-+]?(RM|S\$|\$)?\s*[-+]?\d[\d,]*(\.\d+)?\s*[%km]?$/i;
const numeric = (column: string[]) => {
  const values = column
    .map((c) => c.replace(/[*`]/g, '').trim())
    .filter((c) => !/^[-—–]?$/.test(c));
  return values.length > 0 && values.every((c) => NUMBER_CELL.test(c));
};

/** A table as tab-separated text, which pastes into Google Sheets as cells. */
export function tableTsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          // The cell as it reads (no ** or ` markers), on one line.
          const text = mdInline(cell)
            .map((t) => t.text)
            .join('')
            .replace(/[\t\r\n]/g, ' ');
          // A sheet would run =IMAGE("https://…?d=…") from text a customer
          // typed: a leading ' keeps it text, also behind quotes a sheet
          // unwraps on paste ("=IMAGE(…)"). Plain numbers stay numbers.
          return /^[\s"']*[=+\-@]/.test(text) &&
            !/^[-+]?\d[\d,]*(\.\d+)?%?$/.test(text)
            ? `'${text}`
            : text;
        })
        .join('\t'),
    )
    .join('\n');
}

/**
 * `streaming`: the answer is still arriving, so a trailing table line shows
 * only once its newline has, and a header only once its |---| row has (no
 * raw "| 项目 | 金额" flashing up before the table forms).
 */
export function mdBlocks(text: string, streaming = false): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const last = lines.length - 1;
  // Inside a still-open ``` fence a "|" line is code, not a table.
  if (
    streaming &&
    lines.filter((l) => l.trim().startsWith('```')).length % 2 === 0
  ) {
    if (isRow(lines[last])) lines[last] = '';
    if (
      !lines[last].trim() &&
      isRow(lines[last - 1]) &&
      !isRow(lines[last - 2])
    ) {
      lines[last - 1] = '';
    }
  }
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
      const set = cells(lines[i + 1]).map((c) =>
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
      // A colon in the |---| row wins; an unset numeric column reads right.
      const align = head.map(
        (_, j) =>
          set[j] ?? (numeric(rows.map((r) => r[j] ?? '')) ? 'right' : null),
      );
      blocks.push({ kind: 'table', head, align, rows });
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
    if (list) {
      // One list until its items stop: a blank line between items keeps it
      // going (a ranked list keeps counting 1, 2, 3), and deeper-indented
      // lines are sub-points of the item above.
      const base = indent(line);
      const start = list === NUMBER ? Number(/\d+/.exec(line)![0]) : 1;
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const top = indent(l) <= base + 1;
        if (top && list.test(l)) {
          items.push({ text: list.exec(l)![1], sub: [] });
        } else if (items.length && l.trim() && !top) {
          items
            .at(-1)!
            .sub.push((BULLET.exec(l) ?? NUMBER.exec(l))?.[1] ?? l.trim());
        } else if (
          !l.trim() &&
          list.test(lines[i + 1] ?? '') &&
          indent(lines[i + 1]) <= base + 1
        ) {
          // A blank line between two items of the same list.
        } else {
          break;
        }
        i++;
      }
      blocks.push({ kind: list === BULLET ? 'ul' : 'ol', start, items });
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
