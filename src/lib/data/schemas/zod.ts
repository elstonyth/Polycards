// The app's sole `zod` import. Every schema file imports `z` from here first,
// so this config runs before any schema is built (ESM evaluates a module's
// imports before its body).
import { z } from 'zod';

// Zod 4's JIT compiles schemas with `new Function(...)`; our CSP `script-src`
// has no 'unsafe-eval' (see src/lib/security/csp.ts), so that probe fires a CSP
// violation on every load. `jitless` forces the interpreted parser instead.
z.config({ jitless: true });

// Feature schemas share the CSP-safe parser configuration.
export { z };

/** The schema type the `Store` port (src/lib/store-port.ts) takes — re-exported
 *  so no other module needs to import zod. */
export type { ZodType } from 'zod';
