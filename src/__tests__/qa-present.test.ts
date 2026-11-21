import { describe, expect, it } from 'vitest';

// imported by URL: scripts/ is outside the build context, so a static import would fail the build's type check
const { missing } = (await import(
  new URL('../../scripts/lib/qa-present.mjs', import.meta.url).href
)) as {
  missing: (page: unknown, ...selectors: string[]) => Promise<string>;
};

/** A page stub: each selector matches the count given, anything else matches nothing. */
const page = (counts: Record<string, number>) => ({
  locator: (sel: string) => ({ count: async () => counts[sel] ?? 0 }),
});

describe('qa-present missing()', () => {
  it('is empty when every selector matches', async () => {
    expect(
      await missing(
        page({ '[data-a]': 2, '[data-b]': 1 }),
        '[data-a]',
        '[data-b]',
      ),
    ).toBe('');
  });

  it('names each selector that matches nothing', async () => {
    expect(
      await missing(page({ '[data-a]': 1 }), '[data-a]', '[data-gone]', '#old'),
    ).toBe('no element matches [data-gone], #old');
  });
});
