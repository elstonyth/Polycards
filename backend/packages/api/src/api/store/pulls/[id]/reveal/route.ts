import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// POST /store/pulls/:id/reveal — stamp the first-seen time for a pull so the
// 30s instant-sell window counts from the reveal, not the pull. Idempotent:
// only the first call stamps; later calls return the same deadline.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts (authenticate() then
// the pull-reveal limiter). The customer id comes ONLY from the verified token;
// ownership is enforced in revealPull (foreign/unknown pull ids 404).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.revealPull(id, customerId);

  // THE public-announcement trigger. The Telegram apex board used to hang off
  // `pack.opened`, which fires the instant the roll commits — so the channel
  // announced the card while the player's reels were still spinning and before
  // they had seen it themselves. It now hangs off the flip.
  //
  // Emitted here rather than inside revealPull so the module stays free of the
  // event bus, and only on first_reveal so a re-mounted reveal stage (or the
  // loser of a concurrent-reveal race) cannot post the same hit twice —
  // Telegram has no dedupe of its own.
  //
  // Fire-and-forget on the bus, never awaited into the response: this endpoint
  // returns the sell-window deadline to a player staring at a countdown, and
  // must not wait on a marketing post. A bus failure costs the announcement,
  // never the reveal.
  if (result.first_reveal) {
    const [pull] = await packs.listPulls({ id }, { take: 1 });
    if (pull?.card_id) {
      await req.scope
        .resolve(Modules.EVENT_BUS)
        .emit({
          name: 'pull.revealed',
          data: {
            pull_id: pull.id,
            pack_id: pull.pack_id,
            card_id: pull.card_id,
            customer_id: pull.customer_id,
          },
        })
        .catch(() => {
          // Swallowed on purpose — see above. The bus logs its own failures.
        });
    }
  }

  res.json({ instant_deadline_ms: result.instant_deadline_ms });
}
