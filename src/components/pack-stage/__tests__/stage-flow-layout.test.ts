import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(process.cwd(), 'src/components/pack-stage/pack-stage.module.css'),
  'utf8',
);
const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g),
].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
const find = (sel: string) => rules.filter((r) => r.selector === sel);

describe('the flow layout (pack-stage.module.css)', () => {
  it('pins the stage for the whole flow, only under data-flow-on', () => {
    const pin = find('.flow[data-flow-on] .spinWrap');
    expect(pin.some((r) => /position:\s*sticky/.test(r.body))).toBe(true);
    expect(pin.some((r) => /top:\s*var\(--flow-top\)/.test(r.body))).toBe(true);
  });

  it('lays the page below over the panel, letting taps through to it', () => {
    const over = find('.flow[data-flow-on] .spinAfter');
    expect(
      over.some((r) =>
        /margin-top:\s*calc\(var\(--panel\) \* -1\)/.test(r.body),
      ),
    ).toBe(true);
    expect(over.some((r) => /pointer-events:\s*none/.test(r.body))).toBe(true);
    const sections = find('.flow[data-flow-on] .spinAfter [data-flow-section]');
    expect(sections.some((r) => /pointer-events:\s*auto/.test(r.body))).toBe(
      true,
    );
  });

  it('keeps no wrapper heights of its own (the spacers give the length)', () => {
    expect(css.includes('[data-spin-on]')).toBe(false);
    expect(
      rules.some(
        (r) => r.selector.includes('[data-focus-on]') && /height/.test(r.body),
      ),
    ).toBe(false);
    expect(
      rules.some(
        (r) =>
          r.selector.includes('.spinAfter') && /display:\s*none/.test(r.body),
      ),
    ).toBe(false);
  });

  it('past Closing the stop text and its controls leave, while the panel (the pack) stays drawn into the lineup', () => {
    expect(css.includes('--flow-fade')).toBe(false);
    const past = find(
      ".flow[data-flow-past] .stage.panel [data-testid='focus-stops']",
    );
    expect(past.some((r) => /opacity:\s*0/.test(r.body))).toBe(true);
    expect(past.some((r) => /visibility:\s*hidden/.test(r.body))).toBe(true);
    // a stop block sets its own visibility (visible while on), so the hiding
    // must reach the blocks too, not only their layer
    const inside = find(
      ".flow[data-flow-past] .stage.panel [data-testid='focus-stops'] *",
    );
    expect(inside.some((r) => /visibility:\s*hidden/.test(r.body))).toBe(true);
  });

  it('hides the panel in the free part', () => {
    const free = find('.flow[data-flow-free] .stage.panel');
    expect(free.some((r) => /visibility:\s*hidden/.test(r.body))).toBe(true);
  });
});
