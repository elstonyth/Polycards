import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// Resets the emailpass password for an EXISTING admin user (create-admin.ts
// only handles the user-missing case). Needed after cloning the prod DB into
// local dev: the cloned admin carries prod's password hash, which local devs
// don't know. Reads ADMIN_EMAIL / ADMIN_PASSWORD from env, same contract as
// create-admin.ts.
// Run: medusa exec ./src/scripts/reset-admin-password.ts
export default async function resetAdminPassword({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.ADMIN_EMAIL || 'admin@pokenic.app';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    logger.warn('RESET: ADMIN_PASSWORD not set — nothing to do');
    return;
  }

  const userModule: any = container.resolve(Modules.USER);
  const authService: any = container.resolve(Modules.AUTH);

  const [user] = await userModule.listUsers({ email });
  if (!user) {
    logger.warn(`RESET: no user ${email} — run create-admin.ts instead`);
    return;
  }

  // Drop the old emailpass identity (prod's hash), then register fresh and
  // re-link to the existing user — the same register+link create-admin.ts does.
  //
  // Why delete BEFORE register (not the safer other way round): emailpass keys
  // a provider_identity on entity_id=email, so register() collides while the
  // old identity still exists ("identity already exists"). The old prod hash is
  // also un-restorable (register needs the plaintext, which we don't have). So
  // there is an unavoidable window after the delete where the admin has no
  // emailpass identity. We make a failure in that window LOUD and FATAL (throw,
  // non-zero exit) instead of a silent return, so the operator knows to re-run
  // immediately with the same ADMIN_PASSWORD to restore access.
  const identities = await authService.listAuthIdentities(
    { provider_identities: { entity_id: email, provider: 'emailpass' } },
    { relations: ['provider_identities'] },
  );
  for (const identity of identities) {
    await authService.deleteAuthIdentities([identity.id]);
  }

  const { authIdentity, error } = await authService.register('emailpass', {
    body: { email, password },
  });
  if (error || !authIdentity) {
    // register() types `error` as unknown-ish (string | Error | object), so
    // interpolating it directly can render "[object Object]" — useless in the
    // one message that has to tell the operator how to restore admin login.
    const cause =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
    throw new Error(
      `RESET: emailpass register FAILED after the old identity was deleted — ` +
        `${email} currently has NO login. Re-run this script immediately with ` +
        `the same ADMIN_PASSWORD to restore access. Cause: ${cause}`,
    );
  }
  await authService.updateAuthIdentities({
    id: authIdentity.id,
    app_metadata: { user_id: user.id },
  });

  logger.info(`RESET: password updated for ${email} (user=${user.id})`);
}
