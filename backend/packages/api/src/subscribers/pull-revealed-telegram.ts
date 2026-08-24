import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { postApexPull, type ApexPullEvent } from '../modules/packs/telegram';

// Post-commit subscriber for `pull.revealed` — emitted once per pull by
// POST /store/pulls/:id/reveal, on the call that actually stamped revealed_at.
//
// It used to listen to `pack.opened`, which BOTH open-pack and open-batch emit
// the moment the roll commits. That is several seconds before the player sees
// anything: the reels are still spinning, the card is still face-down, and the
// public channel had already named the card they were about to flip. The flip
// is the moment worth announcing, so the announcement hangs off the flip.
//
// The trade this makes deliberately: a pull nobody ever reveals is never
// announced. That is the requested behaviour — the board exists to celebrate a
// player's moment, and there is no moment until they look.
//
// Forwarder only: every gate (rarity bar, source, disabled player) and the send
// itself live in modules/packs/telegram.ts. postApexPull never throws — see its
// header for why a retry here would mean a duplicate public post.
export default async function pullRevealedTelegramHandler({
  event: { data },
  container,
}: SubscriberArgs<ApexPullEvent>) {
  await postApexPull(container, data);
}

export const config: SubscriberConfig = {
  event: 'pull.revealed',
};
