import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { accessFor } from '../../../../assistant/access';
import { forgetAuthenticator } from '../../../../../utils/admin-mfa-guard';

type Knexish = {
  transaction<T>(fn: (trx: Knexish) => Promise<T>): Promise<T>;
  raw(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

// POST /admin/users/:id/mfa/reset — a Super Admin resets another admin's two-step
// sign-in (owner, 2026-11-07), for a lost or new phone: their authenticator and
// backup codes go, and their next admin request asks them to set up again.
// Medusa's own removal route needs a current code from the login itself, so
// this works on the auth module's tables directly, soft-deleting as the module
// does. Audited.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!accessFor(req.scope, req.auth_context).superAdmin) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Only a Super Admin can reset two-step sign-in.',
    );
  }
  const userId = req.params.id;
  const db = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION,
  ) as unknown as Knexish;

  const result = await db.transaction(async (trx) => {
    const user = (
      await trx.raw(
        'SELECT id, email FROM "user" WHERE id = ? AND deleted_at IS NULL',
        [userId],
      )
    ).rows[0];
    if (!user) return null;
    const identities = (
      await trx.raw(
        "SELECT id FROM auth_identity WHERE deleted_at IS NULL AND app_metadata->>'user_id' = ?",
        [userId],
      )
    ).rows.map((r) => r.id as string);
    if (identities.length === 0) {
      return { email: user.email as string, identities, factors: 0, codes: 0 };
    }
    const factors = (
      await trx.raw(
        'UPDATE auth_mfa_factor SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL AND auth_identity_id = ANY(?::text[]) RETURNING id',
        [identities],
      )
    ).rows.length;
    const codes = (
      await trx.raw(
        'UPDATE auth_mfa_recovery_code SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL AND auth_identity_id = ANY(?::text[]) RETURNING id',
        [identities],
      )
    ).rows.length;
    return { email: user.email as string, identities, factors, codes };
  });
  if (!result) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Admin user ${userId} was not found.`,
    );
  }
  result.identities.forEach(forgetAuthenticator);

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.createAdminActionAudits([
    {
      admin_id: req.auth_context.actor_id,
      entity_type: 'admin_user',
      entity_id: userId,
      action: 'reset_mfa',
      before: { authenticators: result.factors, backup_codes: result.codes },
      after: { authenticators: 0, backup_codes: 0 },
      reason: `two-step sign-in reset for ${result.email}`,
    },
  ]);

  res.json({
    user_id: userId,
    authenticators_removed: result.factors,
    backup_codes_removed: result.codes,
  });
}
