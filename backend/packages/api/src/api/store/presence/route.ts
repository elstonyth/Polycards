import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { presenceStore } from '../../utils/presence';
import { throttledWarn } from '../../utils/rate-limit';

const warn = throttledWarn(60_000);

/**
 * POST /store/presence: the signed-in storefront's heartbeat for the admin
 * Dashboard's "online now" (utils/presence.ts). Best effort: a ping that
 * cannot be recorded still answers 200, because nothing the player sees may
 * depend on it.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  try {
    await presenceStore().touch(req.auth_context.actor_id, Date.now());
  } catch (err) {
    warn('presence ping not recorded', err);
  }
  res.json({ ok: true });
}
