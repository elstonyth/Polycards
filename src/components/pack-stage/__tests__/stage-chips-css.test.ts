import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The site's floating chips (the free pack badge, the Telegram banner) over
// the home flow: shown at the row only, hidden in every other state of the
// flow, so they never sit on the page's own content below the lineup.

const css = readFileSync(
  join(process.cwd(), 'src/components/pack-stage/pack-stage.module.css'),
  'utf8',
);
const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g),
].map((m) => ({
  selectors: (m[1] ?? '').split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
  body: m[2] ?? '',
}));
const hiding = rules.filter((r) => /visibility:\s*hidden/.test(r.body));
const chips = [
  ":global([data-testid='free-pack-badge'])",
  ':global([data-telegram-banner])',
];
/** The selectors that hide this chip. */
const hidersOf = (chip: string) =>
  hiding.flatMap((r) => r.selectors.filter((s) => s.endsWith(chip)));

describe('the floating chips over the flow', () => {
  for (const chip of chips) {
    it(`${chip}: hidden in the focus, past the details, the free part, the lap and Home's fade`, () => {
      const hiders = hidersOf(chip);
      for (const state of [
        '.spinWrap[data-focus-on]',
        '[data-flow-past]',
        '[data-flow-free]',
        '[data-flow-lap]',
        '[data-flow-home]',
      ])
        expect(
          hiders.some((s) => s.includes(state) && !s.includes(':not(')),
          state,
        ).toBe(true);
    });

    it(`${chip}: never hidden by a flow state that is not exempted at the row`, () => {
      for (const s of hidersOf(chip))
        expect(
          /data-focus-on|data-flow-past|data-flow-free|data-flow-lap|data-flow-home/.test(
            s,
          ),
          s,
        ).toBe(true);
    });
  }

  it('fade back in over 0.35 s (with the row UI after the wrap)', () => {
    const t = rules.find((r) =>
      r.selectors.some(
        (s) => s.endsWith(chips[0]!) && /transition-duration/.test(r.body),
      ),
    );
    expect(t?.body).toMatch(/transition-duration:[^;]*0\.35s/);
  });
});
