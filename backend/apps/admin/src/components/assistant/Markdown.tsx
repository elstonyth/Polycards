import { Fragment, type ReactNode } from 'react';
import { mdBlocks, mdInline } from './markdown-parse';

// The assistant's answer as React elements (markdown-parse.ts: no HTML, no
// images, http(s) links only, opened in a new tab without a referrer).

function inline(text: string): ReactNode {
  return mdInline(text).map((t, i) => {
    if (t.kind === 'bold') {
      return (
        <strong key={i} className="text-ui-fg-base font-semibold">
          {t.text}
        </strong>
      );
    }
    if (t.kind === 'code') {
      return (
        <code
          key={i}
          className="bg-ui-bg-component rounded px-1 py-px font-mono text-[0.85em]"
        >
          {t.text}
        </code>
      );
    }
    if (t.kind === 'link') {
      return (
        <a
          key={i}
          href={t.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-ui-fg-interactive hover:underline"
        >
          {t.text}
        </a>
      );
    }
    return <Fragment key={i}>{t.text}</Fragment>;
  });
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-ui-fg-base flex min-w-0 flex-col gap-y-3 break-words text-[13.5px] leading-relaxed [overflow-wrap:anywhere]">
      {mdBlocks(text).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p
                key={i}
                className={
                  b.level === 1
                    ? 'text-base font-semibold'
                    : 'text-[14px] font-semibold'
                }
              >
                {inline(b.text)}
              </p>
            );
          case 'ul':
          case 'ol': {
            const List = b.kind;
            return (
              <List
                key={i}
                start={b.kind === 'ol' ? b.start : undefined}
                className={`flex flex-col gap-y-1 pl-5 ${b.kind === 'ul' ? 'list-disc' : 'list-decimal'}`}
              >
                {b.items.map((item, j) => (
                  <li key={j}>
                    {inline(item.text)}
                    {item.sub.length > 0 && (
                      <ul className="mt-1 flex list-[circle] flex-col gap-y-0.5 pl-5">
                        {item.sub.map((s, k) => (
                          <li key={k}>{inline(s)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </List>
            );
          }
          case 'code':
            return (
              <pre
                key={i}
                className="bg-ui-bg-component overflow-x-auto rounded-lg p-3 font-mono text-xs"
              >
                {b.text}
              </pre>
            );
          case 'table':
            return (
              <div
                key={i}
                className="border-ui-border-base overflow-x-auto rounded-xl border"
              >
                <table className="w-full border-collapse text-[13px]">
                  <thead className="bg-ui-bg-component">
                    <tr>
                      {b.head.map((h, j) => (
                        <th
                          key={j}
                          className={`text-ui-fg-subtle whitespace-nowrap px-3 py-2 font-medium ${ALIGN[b.align[j] ?? 'left']}`}
                        >
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-ui-border-base border-t">
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className={`px-3 py-1.5 tabular-nums ${ALIGN[b.align[j] ?? 'left']}`}
                          >
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={i}>
                {b.lines.map((line, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(line)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
