import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const css = src('src/components/pack-flow/home-flow.module.css');
const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g),
].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));

describe('the flow spacers (home-flow.module.css)', () => {
  it('have no height and take no taps by default', () => {
    const base = rules.find((r) => r.selector === '.spacer');
    expect(base?.body).toMatch(/height:\s*0;/);
    expect(base?.body).toMatch(/pointer-events:\s*none;/);
  });

  it('take a height only under data-flow-on', () => {
    const sized = rules.filter(
      (r) =>
        r.selector.includes('.spacer') &&
        r.selector !== '.spacer' &&
        /height/.test(r.body),
    );
    expect(sized.length).toBeGreaterThan(0);
    for (const r of sized)
      for (const part of r.selector.split(','))
        expect(part, part).toContain('[data-flow-on]');
  });

  it('have no Exit spacer rule: the lineup exits over the Lineup spacer alone', () => {
    expect(css).not.toContain("[data-flow-spacer='exit']");
    const lineup = rules.find((r) =>
      r.selector.includes("[data-flow-spacer='lineup']"),
    );
    expect(lineup?.body).toMatch(/height:\s*calc\(var\(--panel\) \* 1\.25\)/);
  });

  it('give Return and Last no height until their own flags', () => {
    const of = (name: string) =>
      rules.filter((r) => r.selector.includes(`[data-flow-spacer='${name}']`));
    for (const r of of('return'))
      expect(r.selector).toContain('[data-flow-return]');
    for (const r of of('last'))
      expect(r.selector).toContain('[data-flow-last]');
  });

  it("hide only the layout's footer, a direct child of body", () => {
    const hide = rules.find((r) =>
      r.selector.includes('footer[data-site-chrome]'),
    );
    expect(hide?.body).toMatch(/display:\s*none/);
    expect(hide?.selector).toMatch(/>\s*:global\(footer\[data-site-chrome\]\)/);
    // only while the flow runs (the plain document keeps it), keyed to the
    // flow page's own spacers
    expect(hide?.selector).toMatch(
      /:has\(:global\(\[data-home-flow\]\[data-flow-on\]\) \.spacer\)/,
    );
  });
});

describe('the preview page', () => {
  const page = src('src/app/home-preview/page.tsx');
  const stage = src('src/components/pack-stage/PackStage.tsx');

  it('renders the flow sections below the stage', () => {
    expect(page.includes('<FlowSections')).toBe(true);
  });

  it('marks the flow root', () => {
    expect(/ref=\{flowRef\}[^>]*data-home-flow/.test(stage)).toBe(true);
  });
});
