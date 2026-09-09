import { ExecArgs } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
} from '@medusajs/framework/utils';
import { chmodSync, writeFileSync } from 'node:fs';

// Local QA tool — the ADMIN twin of qa-mint-google-customer.ts. Mints a
// dashboard session token for an EXISTING admin user without a password, so a
// Playwright capture (scripts/qa-admin-shot.mjs) can POST /auth/session and
// open the dashboard logged in. The claims mirror core's
// generateJwtTokenForAuthIdentity (@medusajs/medusa dist/api/auth/utils) —
// actor, auth_identity_id, provider and the RBAC role ids the admin's
// permission checks read — which cannot be imported here (the package's
// exports map hides that path from the CJS loader). The token never goes to
// stdout — point QA_JWT_OUT OUTSIDE the repo so it can never be committed.
// Run (from backend/packages/api):
//   QA_JWT_OUT=/path/to/qa-admin.jwt [QA_ADMIN_EMAIL=...] \
//     ./node_modules/.bin/medusa exec ./src/scripts/qa-mint-admin-session.ts
export default async function qaMintAdminSession({ container }: ExecArgs) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('qa-mint-admin-session is local-only');
  const out = process.env.QA_JWT_OUT;
  if (!out) throw new Error('QA_JWT_OUT not set — nothing to do');

  const users: any = container.resolve(Modules.USER);
  const auth: any = container.resolve(Modules.AUTH);
  const email = process.env.QA_ADMIN_EMAIL;
  const [user] = await users.listUsers(email ? { email } : {}, {
    take: 1,
    order: { created_at: 'ASC' },
  });
  if (!user) throw new Error('no admin user found');
  const [identity] = await auth.listAuthIdentities(
    { provider_identities: { entity_id: user.email, provider: 'emailpass' } },
    { relations: ['provider_identities'] },
  );
  if (!identity) throw new Error(`no emailpass identity for user ${user.id}`);

  // RBAC role ids ride in the token (core reads them from the graph the same
  // way); an admin with no roles would 403 on every /admin/* call.
  const query: any = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: 'user',
    fields: ['rbac_roles.id'],
    filters: { id: user.id },
  });
  const roles: string[] = (data?.[0]?.rbac_roles ?? []).map(
    (r: { id: string }) => r.id,
  );

  const { http } = container.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  const token = generateJwtToken(
    {
      actor_id: user.id,
      actor_type: 'user',
      auth_identity_id: identity.id,
      auth_provider: 'emailpass',
      app_metadata: { ...(identity.app_metadata ?? {}), user_id: user.id, roles },
      user_metadata: {},
    },
    {
      secret: http.jwtSecret as string,
      expiresIn: http.jwtExpiresIn,
      jwtOptions: http.jwtOptions,
    },
  );
  // Owner-only: `mode` applies to a NEW file, chmod covers an existing one.
  writeFileSync(out, `${token}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(
    `QA admin session for user ${user.id} (${roles.length} role(s)) written to ${out}`,
  );
}
