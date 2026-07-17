import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { fetchTcgCardMeta } from '../tcg-meta';

// GET /admin/tcg/card-meta?set=<pc console-name>&number=<238> — label-prefill
// lookup (spec §7a). Admin-authed by path. Always 200 with nullable fields:
// a lookup miss/outage means "operator types it", never an error state.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const set = typeof req.query.set === 'string' ? req.query.set : '';
  const number = typeof req.query.number === 'string' ? req.query.number : '';
  if (set.trim() === '') {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "'set' is required.");
  }
  res.json(await fetchTcgCardMeta(set, number));
}
