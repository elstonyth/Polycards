import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FREE_WELCOME_CATEGORY,
  FREE_PULL_LOCKED_MESSAGE,
} from '@/lib/packs-data';
// The backend module is plain TS with no Medusa imports, so it is directly
// importable across the package boundary (unlike backend/apps/admin's
// format.ts case in plans/041, whose target only exports a generated build).
import {
  FREE_WELCOME_CATEGORY as BACKEND_FREE_WELCOME_CATEGORY,
  FREE_PULL_LOCKED_MESSAGE as BACKEND_FREE_PULL_LOCKED_MESSAGE,
} from '../../../backend/packages/api/src/modules/packs/free-pack';

// The admin SPA's copy (backend/apps/admin/src/routes/packs/page.tsx) is a
// React route pulling in @medusajs/ui and friends -- not safely importable
// from this project's vitest run. Read the source text and regex out its
// FREE_WELCOME_CATEGORY literal instead, same cross-package technique as
// buyback-parity.test.ts uses for the backend's FLAT_PERCENT.
const ADMIN_SRC = join(
  process.cwd(),
  'backend/apps/admin/src/routes/packs/page.tsx',
);

function adminFreeWelcomeCategory(): string {
  const src = readFileSync(ADMIN_SRC, 'utf8');
  const m = src.match(/const FREE_WELCOME_CATEGORY\s*=\s*'([^']+)'/);
  if (!m) {
    throw new Error(
      `FREE_WELCOME_CATEGORY not found in ${ADMIN_SRC}. If it was renamed or ` +
        `moved, update this guard -- do not delete it.`,
    );
  }
  return m[1];
}

// FREE_WELCOME_CATEGORY and FREE_PULL_LOCKED_MESSAGE are hand-copied across
// three deploy units (storefront, backend, admin SPA). The storefront's copy
// must stay VERBATIM equal to the backend's -- the server returns that exact
// message string on a refused sell/deliver -- and a drifted category would
// silently turn off every free-pack branch on the storefront with no error.
describe('free-pack constant parity: storefront mirror vs backend truth', () => {
  it('storefront FREE_WELCOME_CATEGORY matches backend FREE_WELCOME_CATEGORY', () => {
    expect(FREE_WELCOME_CATEGORY).toBe(BACKEND_FREE_WELCOME_CATEGORY);
  });

  it('storefront FREE_PULL_LOCKED_MESSAGE matches backend FREE_PULL_LOCKED_MESSAGE verbatim', () => {
    expect(FREE_PULL_LOCKED_MESSAGE).toBe(BACKEND_FREE_PULL_LOCKED_MESSAGE);
  });

  it('admin SPA FREE_WELCOME_CATEGORY matches backend FREE_WELCOME_CATEGORY', () => {
    expect(adminFreeWelcomeCategory()).toBe(BACKEND_FREE_WELCOME_CATEGORY);
  });
});
