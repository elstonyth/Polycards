import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import type { Knex } from 'knex';
import { normalizeCardArtCode } from '../parse';

// DELETE /admin/card-art/:code — drop one printing's clean image (a wrong
// upload). Cards already saved keep the image URL they were created with.
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const code = normalizeCardArtCode(String(req.params.code ?? ''));
  if (!code)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Not a card code.');
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const { rowCount } = await db.raw(`delete from card_art where code = ?`, [
    code,
  ]);
  res.json({ code, deleted: rowCount > 0 });
}
