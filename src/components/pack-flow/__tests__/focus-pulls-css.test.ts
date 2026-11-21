import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Recent Pulls on the stage: a chase-tier row keeps its wash, not the line
// down its left edge. The row sets that line inline (an inset box-shadow), on
// the server as written and in the browser as the browser rewrites it, so the
// rule matches the word both forms share.

const css = readFileSync(
  join(process.cwd(), 'src/components/pack-flow/focus.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
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
  });

  it('the wash stays: no rule clears the row background', () => {
    const rule = rules.find((r) => r.selector.includes("[style*='inset']"));
    expect(rule?.body).not.toMatch(/background/);
  });
});
