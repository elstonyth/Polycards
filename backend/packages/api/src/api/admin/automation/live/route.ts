import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { changeLive, readLive } from '../../../utils/automation-live-store';

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json(await readLive(req.scope));
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  await changeLive(req.scope, req.body, req.auth_context.actor_id);
  res.json(await readLive(req.scope));
}
