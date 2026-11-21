/**
 * Guards for the pack stage:
 * - The stage must sit on the route-cached `/` later, so nothing under
 *   `src/components/pack-stage/` may read cookies, headers or search params.
 * - Only `runtime/` (the async `pack-stage-3d` chunk) may import `three` or
 *   `@/components/pack-3d/*`. The one exception: server-safe `stage-packs.ts`
 *   may use the catalogue's sync lookup under `pack-3d/catalog`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT)
  .filter((p) => p !== SELF)
  .map((p) => ({
    rel: relative(ROOT, p).split(sep).join('/'),
    src: readFileSync(p, 'utf8'),
  }));

const SERVER_READS: [string, RegExp][] = [
  ['next/headers', /['"]next\/headers['"]/],
  ['cookies(', /\bcookies\s*\(/],
  ['headers(', /\bheaders\s*\(/],
  ['useSearchParams', /\buseSearchParams\b/],
];

const THREE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]three(?:\/[^'"]*)?['"]/;
const PACK_3D =
  /['"](?:@\/components\/pack-3d|(?:\.\.\/)+pack-3d)(\/[^'"]*)?['"]/g;

/** The sync lookups: the sleeve catalogue's and the capsule set's index only. */
const lookupOnly = (sub: string) =>
  sub.startsWith('/catalog') || sub === '/capsule' || sub === '/capsule/index';

describe('pack-stage import guards', () => {
  it('finds the stage files', () => {
    expect(files.some((f) => f.rel === 'Stage3dProvider.tsx')).toBe(true);
  });

  it('the patterns catch real violations (positive control)', () => {
    const bad = [
      "import { cookies } from 'next/headers';",
      'const c = await cookies();',
      'const h = headers ();',
      "import { useSearchParams } from 'next/navigation';",
    ];
    for (const [i, [, re]] of SERVER_READS.entries())
      expect(re.test(bad[i] ?? '')).toBe(true);
    expect(THREE.test("import * as THREE from 'three';")).toBe(true);
    expect(THREE.test("import { Mesh } from 'three/webgpu';")).toBe(true);
    expect(THREE.test("await import('three')")).toBe(true);
    expect(THREE.test("import x from './three-ish'")).toBe(false);
    const p3 = (s: string) => [...s.matchAll(PACK_3D)].map((m) => m[1] ?? '');
    expect(p3("import { x } from '@/components/pack-3d/pack-studio';")).toEqual(
      ['/pack-studio'],
    );
    expect(p3("import { y } from '../pack-3d/catalog/lookup';")).toEqual([
      '/catalog/lookup',
    ]);
    expect(p3("import { z } from './pack-stage-3d';")).toEqual([]);
    expect(lookupOnly('/capsule')).toBe(true);
    expect(lookupOnly('/capsule/build')).toBe(false);
    expect(lookupOnly('/capsule-x')).toBe(false);
  });

  it('never reads cookies, headers or search params', () => {
    const hits = files.flatMap((f) =>
      SERVER_READS.filter(([, re]) => re.test(f.src)).map(
        ([name]) => `${f.rel}: ${name}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it('imports three only inside runtime/', () => {
    const hits = files
      .filter((f) => !f.rel.startsWith('runtime/') && THREE.test(f.src))
      .map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it('imports pack-3d only inside runtime/ (stage-packs.ts may use the catalogue lookup)', () => {
    const hits: string[] = [];
    for (const f of files) {
      if (f.rel.startsWith('runtime/')) continue;
      for (const m of f.src.matchAll(PACK_3D)) {
        const sub = m[1] ?? '';
        const allowed = f.rel === 'stage-packs.ts' && lookupOnly(sub);
        if (!allowed) hits.push(`${f.rel}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
