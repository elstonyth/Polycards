import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(process.cwd(), 'src/components/pack-stage/pack-stage.module.css'),
  'utf8',
);
// innermost rules only, so a rule inside @media is read on its own
const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
const pe = (body: string) =>
  /pointer-events:\s*([^;]+);/.exec(body)?.[1]?.trim();
/** Rules whose selector list has a part ending in exactly this class. */
const endingIn = (cls: string) =>
  rules.filter((r) =>
    r.selector
      .split(',')
      .some((part) => new RegExp(`\\${cls}\\s*$`).test(part.trim())),
  );

describe('the top row takes taps only where a pack is drawn (pack-stage.module.css)', () => {
  it('the flat row list takes no taps: the set-back packs sit behind it', () => {
    const row = rules.find((r) => r.selector === '.row');
    expect(pe(row?.body ?? '')).toBe('none');
    // no later rule hands the row (or a tile, which inherits it) taps back
    for (const r of [...endingIn('.row'), ...endingIn('.tile')])
      expect(pe(r.body) ?? 'none', r.selector).toBe('none');
  });

  it('each posed pack and its label keep their own taps', () => {
    const pose = rules.find((r) => r.selector === '.pose');
    const label = rules.find((r) => r.selector === '.label');
    expect(pe(pose?.body ?? '')).toBe('var(--pe)');
    expect(pe(label?.body ?? '')).toBe('var(--lpe)');
  });
});
