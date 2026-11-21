import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Recent Pulls on the stage: a chase-tier row keeps its wash, not the line
// down its left edge. The row sets that line inline (an inset box-shadow), on
// the server as written and in the browser as the browser rewrites it, so the
// rule matches the row's wash plus the word inset, which both forms share.

const css = readFileSync(
  join(process.cwd(), 'src/components/pack-flow/focus.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
// Would the selector's attribute filters match this inline style?
const matches = (selector: string, style: string) =>
  [...selector.matchAll(/\[style\*='([^']*)'\]/g)].every((m) =>
    style.includes(m[1] ?? ''),
  );

const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? '').replace(/\s+/g, ' ').trim(),
  body: m[2] ?? '',
}));

describe('Recent Pulls on the stage', () => {
  it("a chase-tier row's edge line is off, whatever the layout", () => {
    const rule = rules.find(
      (r) =>
        r.selector.includes("[data-kind='pulls']") &&
        r.selector.includes("[style*='inset']"),
    );
    expect(rule).toBeDefined();
    expect(rule?.selector.startsWith('.block')).toBe(true);
    expect(rule?.body).toMatch(/box-shadow:\s*none\s*!important/);
    const sel = rule?.selector ?? '';
    const server =
      'background-image:linear-gradient(90deg, rgba(1,2,3, 0.14), transparent 55%);box-shadow:inset 3px 0 0 rgb(1,2,3)';
    const browser =
      'background-image: linear-gradient(90deg, rgba(1, 2, 3, 0.14), transparent 55%); box-shadow: rgb(1, 2, 3) 3px 0px 0px 0px inset;';
    expect(matches(sel, server)).toBe(true);
    expect(matches(sel, browser)).toBe(true);
    expect(matches(sel, 'inset: 0')).toBe(false);
    expect(
      matches(sel, 'box-shadow:inset 0 -28px 40px -36px rgba(1,2,3, 0.7)'),
    ).toBe(false);
  });

  it('the wash stays: no rule clears the row background', () => {
    const rule = rules.find((r) => r.selector.includes("[style*='inset']"));
    expect(rule?.body).not.toMatch(/background/);
  });
});
