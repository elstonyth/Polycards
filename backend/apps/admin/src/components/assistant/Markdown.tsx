import { Fragment, type ReactNode } from 'react';
import { toast } from '@medusajs/ui';
import { useTranslation } from 'react-i18next';
import { mdBlocks, mdInline, tableTsv } from './markdown-parse';

// The assistant's answer as React elements (markdown-parse.ts: no HTML, no
// images, http(s) links only, opened in a new tab without a referrer).

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() =>
        // Called in the click itself: Safari refuses a clipboard write made
        // after it. navigator.clipboard is undefined off https: that throw
        // lands in the failure toast instead of escaping the click.
        new Promise<void>((resolve) =>
          resolve(navigator.clipboard.writeText(text)),
        ).then(
          () =>
            toast.success(
              t('assistant.markdown.copied', { defaultValue: 'Copied' }),
            ),
          () =>
            toast.error(
              t('assistant.markdown.copyFailed', {
                defaultValue: "Couldn't copy",
              }),
            ),
        )
      }
      className="text-ui-fg-muted hover:text-ui-fg-base hover:bg-ui-bg-base-hover w-fit self-end rounded-full px-2 py-0.5 text-[11px] transition-colors"
    >
      {t('assistant.markdown.copy', { defaultValue: 'Copy' })}
    </button>
  );
}

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

export function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  /** Still arriving: hold back a table until its rows are whole. */
  streaming?: boolean;
}) {
  return (
    <div className="text-ui-fg-base flex min-w-0 flex-col gap-y-3 break-words text-[13.5px] leading-relaxed [overflow-wrap:anywhere]">
      {mdBlocks(text, streaming).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p
                key={i}
                className={
                  b.level === 1
                    ? 'text-base font-semibold leading-snug'
                    : 'text-[14px] font-semibold leading-snug'
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
              <div key={i} className="flex min-w-0 flex-col gap-y-1">
                <pre className="bg-ui-bg-component overflow-x-auto rounded-lg p-3 font-mono text-xs">
                  {b.text}
                </pre>
                <CopyButton text={b.text} />
              </div>
            );
          case 'table':
            return (
              <div key={i} className="flex min-w-0 flex-col gap-y-1">
                <div className="border-ui-border-base overflow-x-auto rounded-xl border">
                  {/* overflow-wrap:anywhere would crush the columns to one
                      letter; normal lets a wide table scroll in its box. */}
                  <table className="w-full border-collapse text-[13px] [overflow-wrap:normal]">
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
                              className={`px-3 py-1.5 tabular-nums ${ALIGN[b.align[j] ?? 'left']} ${b.align[j] === 'right' ? 'whitespace-nowrap' : ''}`}
                            >
                              {inline(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Tab-separated: pastes into Google Sheets as cells. */}
                <CopyButton text={tableTsv([b.head, ...b.rows])} />
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
