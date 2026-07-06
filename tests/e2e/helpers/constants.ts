// Shared endpoints + credentials for the live E2E stack. Overridable via env so
// the same suite can target a remote deployment if needed.
export const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
export const ADMIN = process.env.PW_ADMIN ?? 'http://localhost:7000/dashboard';
export const BACKEND = process.env.PW_BACKEND ?? 'http://localhost:9000';

// Storefront publishable key (baked into the :4000 build).
export const PK =
  process.env.PW_PK ??
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';

// Seeded operator — created by create-admin.ts (deploy:migrate-user) from
// ADMIN_EMAIL/ADMIN_PASSWORD. The old qa-admin@pokenic.local seed is dead.
export const ADMIN_EMAIL = process.env.PW_ADMIN_EMAIL ?? 'admin@pokenic.local';
export const ADMIN_PASSWORD =
  process.env.PW_ADMIN_PASSWORD ?? 'pokenicadmin2026';

// The statically published Pull Odds (src/app/claw/packs-data.ts ODDS). These
// are decoupled from the admin-tuned secret weights ON PURPOSE — the storefront
// must keep showing exactly these regardless of any odds adjustment.
export const PUBLISHED_ODDS: ReadonlyArray<readonly [string, string]> = [
  ['Legendary', '0.5%'],
  ['Epic', '4.5%'],
  ['Rare', '15%'],
  ['Uncommon', '30%'],
  ['Common', '50%'],
];

// Unique-per-run id so reruns never collide on email/slug.
export const stamp = (): string => `${Date.now()}`;
