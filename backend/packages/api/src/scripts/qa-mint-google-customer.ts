import { ExecArgs } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
// Declared at the workspace root (backend/package.json), reached via hoisting —
// the first direct import of it under packages/api/src.
import jwt from 'jsonwebtoken';
import { chmodSync, writeFileSync } from 'node:fs';

// Local QA tool — the customer-side twin of reset-customer-password.ts for the
// cohort that has no password. Seeds a throwaway GOOGLE-ONLY customer
// (has_account, no phone, a `google` provider identity and no emailpass one —
// what matters to the phone-change re-auth gate; the real provider stores
// Google's `sub` as entity_id, which nothing here keys on) and writes a
// session JWT for it to QA_JWT_OUT, so scripts/qa-phone-onboarding.mjs can
// seed the storefront cookie without a live Google OAuth round-trip. The token
// never goes to stdout — point QA_JWT_OUT OUTSIDE the repo so it can never be
// committed. Every run leaves one qa-google-*@polycards.local row.
// Run (from backend/packages/api):
//   QA_JWT_OUT=/path/to/qa-google.jwt \
//     ./node_modules/.bin/medusa exec ./src/scripts/qa-mint-google-customer.ts
export default async function qaMintGoogleCustomer({ container }: ExecArgs) {
  // It creates rows and mints a session: never on prod (scripts/do-exec.mjs
  // can route exec scripts there).
  if (process.env.NODE_ENV === 'production')
    throw new Error('qa-mint-google-customer is local-only');
  const out = process.env.QA_JWT_OUT;
  if (!out) throw new Error('QA_JWT_OUT not set — nothing to do');
  const email = `qa-google-${Date.now()}@polycards.local`;
  const customers: any = container.resolve(Modules.CUSTOMER);
  const auth: any = container.resolve(Modules.AUTH);
  // Array in, array out — the module services overload single vs array, and
  // the array form leaves no doubt which one this is.
  const [customer] = await customers.createCustomers([
    { email, has_account: true },
  ]);
  const [identity] = await auth.createAuthIdentities([
    {
      provider_identities: [
        { provider: 'google', entity_id: `qa-sub-${Date.now()}` },
      ],
      app_metadata: { customer_id: customer.id },
    },
  ]);
  // The claims `authenticate()` reads. Core's own session token also carries
  // auth_provider / user_metadata / app_metadata.roles; nothing in these flows
  // reads them.
  const { jwtSecret, jwtExpiresIn } =
    container.resolve('configModule').projectConfig.http;
  const token = jwt.sign(
    {
      actor_id: customer.id,
      actor_type: 'customer',
      auth_identity_id: identity.id,
      app_metadata: { customer_id: customer.id },
    },
    jwtSecret as string,
    { expiresIn: (jwtExpiresIn as any) ?? '1d' },
  );
  // Owner-only: `mode` applies to a NEW file, chmod covers an existing one.
  writeFileSync(out, `${token}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(
    `QA google-only customer ${customer.id} — token written to ${out}`,
  );
}
