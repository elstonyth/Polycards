import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import custom from './en.json';

// The dashboard merges locales with `deepMerge(coreTranslations, customI18n)`
// (@mercurjs/admin/dist, `function deepMerge`): object-vs-object recurses, but
// leaf-vs-ANYTHING assigns `result[key] = source[key]`. So a custom key whose
// path meets a core key of the SAME NAME DISPLACES it — and a custom LEAF over
// a core OBJECT wipes that whole core subtree. That is how `inventory.subtitle`
// silently retitled Medusa's core Inventory Items screen.
//
// Nothing else can catch this: tsc does not type i18n keys, eslint does not
// know them, and this app has no harness that renders a core page. Note the
// question here is NOT "does my key resolve?" — a key audit answers that and
// still misses every shadow, because a shadowing key resolves perfectly.
const DIST = join(__dirname, '../../node_modules/@mercurjs/admin/dist');

// Globbed, never hardcoded: the chunk filename is content-hashed and changes on
// every @mercurjs/admin bump. Anchored on the declaration, not the bare
// identifier, so a chunk that merely references en_default is not mistaken for
// the one that defines it.
const ANCHOR = /var\s+en_default\s*=\s*\{/;

const loadCoreEn = (): Record<string, unknown> => {
  for (const file of readdirSync(DIST)) {
    if (!file.endsWith('.js')) continue;
    const src = readFileSync(join(DIST, file), 'utf8');
    const m = ANCHOR.exec(src);
    if (!m) continue;
    // Brace scan that skips string literals: translations contain `{{name}}`,
    // so naive brace counting closes the object in the wrong place.
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let inStr = false;
    let i = start;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        i++;
        break;
      }
    }
    return vm.runInNewContext(`(${src.slice(start, i)})`) as Record<
      string,
      unknown
    >;
  }
  throw new Error(
    `No chunk under ${DIST} declares en_default. The @mercurjs/admin bundle ` +
      `layout changed — fix this loader rather than deleting the check.`,
  );
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every custom path that DISPLACES a core one under deepMerge's semantics. */
const shadowedKeys = (
  core: unknown,
  cus: unknown,
  path: string[] = [],
): string[] => {
  // Both objects is the only branch deepMerge recurses on; anything else at a
  // shared name is an overwrite, whichever side is the leaf.
  if (isObj(core) && isObj(cus)) {
    return Object.keys(cus)
      .filter((k) => k in core)
      .flatMap((k) => shadowedKeys(core[k], cus[k], [...path, k]));
  }
  return [path.join('.')];
};

describe('custom i18n keys do not shadow core dashboard keys', () => {
  it('detects a displacement whichever side is the leaf', () => {
    const core = { a: 'core', b: { c: 'core' }, d: { e: 'core' } };
    expect(shadowedKeys(core, { a: 'mine' })).toEqual(['a']);
    // A custom LEAF over a core OBJECT takes the whole subtree with it — core
    // owns five objects under `inventory` alone, so this case is not academic.
    expect(shadowedKeys(core, { b: 'mine' })).toEqual(['b']);
    // ...and a custom OBJECT over a core LEAF replaces that leaf outright.
    expect(shadowedKeys(core, { a: { x: 'mine' } })).toEqual(['a']);
    expect(shadowedKeys(core, { d: { e: 'mine' } })).toEqual(['d.e']);
    // Additive keys — a new sibling and a new top-level branch — are clean.
    expect(shadowedKeys(core, { d: { z: 'mine' } })).toEqual([]);
    expect(shadowedKeys(core, { fresh: 'mine' })).toEqual([]);
  });

  it('shadows nothing in the shipped bundle beyond the deliberate rename', () => {
    const core = loadCoreEn();
    // A silently empty extraction would find no shadows and pass vacuously.
    expect(Object.keys(core).length).toBeGreaterThan(50);
    expect(isObj(core.inventory)).toBe(true);
    // ...and a NON-EMPTY extraction of the WRONG object would pass all three
    // guards above. `commission` is bundled into en_default but absent from
    // @medusajs/dashboard's raw src/i18n/translations/en.json, which carries 58
    // top-level keys (> 50), `inventory` as an object, and
    // `customers.domain === "Customers"` — so swapping this loader for a
    // require() of that JSON stays green while hiding 298 bundle-only leaves.
    expect(core.commission).toBeDefined();

    // `customers.domain` retitles core's "Customers" to "Players" — a
    // deliberate, pre-existing brand rename, and the positive control that
    // proves this walk actually reaches the real bundle.
    expect(shadowedKeys(core, custom)).toEqual(['customers.domain']);
  });
});
