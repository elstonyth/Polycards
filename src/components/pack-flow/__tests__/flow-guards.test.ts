import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The flow will sit on the route-cached `/`: nothing in it may read cookies,
// headers or search params (the pack-stage guard's patterns), and it never
// imports the stage or the 3D runtime. (The "published" rule for what the flow
// sends a browser is checked on the seed itself, in flow-back.test.ts.)

const DIR = join(process.cwd(), 'src', 'components', 'pack-flow');
const files = readdirSync(DIR)
  .filter((n) => /\.(ts|tsx|css)$/.test(n))
  .map((n) => ({ name: n, src: readFileSync(join(DIR, n), 'utf8') }));

describe('pack-flow guards', () => {
  it('finds the flow files', () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'FocusStops.tsx',
        'flow-back.ts',
        'flow-seed.ts',
        'use-flow-data.ts',
        'types.ts',
      ]),
    );
  });

  it.each([
    ['next/headers', /['"]next\/headers['"]/],
    ['cookies(', /\bcookies\s*\(/],
    ['headers(', /\bheaders\s*\(/],
    ['the search-params hook', /\buse(Search)Params\b/],
  ])('never uses %s', (_name, re) => {
    expect(files.filter((f) => re.test(f.src)).map((f) => f.name)).toEqual([]);
  });

  it('never imports the pack stage or the 3D runtime (stand-ins and props only)', () => {
    const hits = files.filter(
      (f) =>
        /['"]@\/components\/pack-stage/.test(f.src) ||
        /['"]three['"]/.test(f.src) ||
        /['"]@\/components\/pack-3d\/(?!pack-back-details|pack-print)/.test(
          f.src,
        ),
    );
    expect(hits.map((f) => f.name)).toEqual([]);
  });
});
