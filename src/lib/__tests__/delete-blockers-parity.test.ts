import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DELETE_LINK } from '@/lib/actions/account-lifecycle-map';

// DELETE_LINK's keys are a hand-copy of the backend's DeleteBlockReason union,
// which account-lifecycle-map.ts states in its own header. The backend decides
// WHY a delete was refused; the storefront decides WHERE to send the customer
// to clear it. A backend-only addition renders a refusal with no way out -- a
// dead end on an irreversible action -- and a storefront-only key is dead code
// nobody notices.
//
// account-lifecycle.test.ts already pins this key set against a hardcoded list
// and checks each entry's shape, but nothing there can see the backend. This is
// the other half; the two move together.
//
// Read from source rather than imported: the backend is a separate package with
// its own tsconfig, not on this project's module graph (same technique as
// buyback-parity.test.ts), and a type has no runtime value to import anyway.
const BACKEND_SRC = join(
  process.cwd(),
  'backend/packages/api/src/modules/packs/service.ts',
);

/**
 * A guard that silently passes when its regex stops matching is worse than no
 * guard, so this throws instead of returning an empty set -- an empty read
 * would blame the storefront for a backend rename.
 *
 * Line-anchored (`^\s*` + /m) so a commented-out previous union above the live
 * one cannot win. Quotes are matched as `['"]` rather than `'` alone: the
 * backend is NOT format-gated (eslint ignores packages/api, the root
 * format:check is storefront-only) and a stray prettier pass rewriting its
 * quotes must not turn this red with a message blaming a rename.
 */
function backendDeleteBlockReasons(src: string): string[] {
  const body = src.match(/^\s*export type DeleteBlockReason\s*=([^;]+);/m)?.[1];
  // `body` is only the union's right-hand side, so every quoted string in it is
  // a member -- matched loosely on purpose. Narrowing to SCREAMING_CASE would
  // silently DROP a differently-cased future member, and if the storefront also
  // lacked it the comparison below would pass over the exact dead end this file
  // exists to catch.
  const members = body?.match(/['"]([^'"]+)['"]/g)?.map((q) => q.slice(1, -1));
  if (!members?.length) {
    throw new Error(
      `DeleteBlockReason not found in ${BACKEND_SRC}, or it no longer lists ` +
        `string literals. If it was renamed or moved, update this guard -- ` +
        `do not delete it.`,
    );
  }
  return members.sort();
}

describe('delete blocker parity: storefront mirror vs backend truth', () => {
  it('DELETE_LINK routes exactly the backend DeleteBlockReason set', () => {
    const backend = backendDeleteBlockReasons(
      readFileSync(BACKEND_SRC, 'utf8'),
    );
    // Guard the guard: a one-member read would compare almost nothing.
    expect(backend.length).toBeGreaterThan(1);
    // Equality, not subset, in both directions. If a future reason is fixable
    // inside the modal (as the password codes are -- which is why they are not
    // in this union at all), exclude it here by name rather than loosening
    // this to a subset check and losing the dead-end guarantee.
    expect(Object.keys(DELETE_LINK).sort()).toEqual(backend);
  });

  // The backend is not format-gated, so its quote style is incidental. A
  // prettier pass must not read as a rename.
  it('reads the union whichever quote style the backend is written in', () => {
    expect(
      backendDeleteBlockReasons('export type DeleteBlockReason = "A" | "B";\n'),
    ).toEqual(['A', 'B']);
  });
});
