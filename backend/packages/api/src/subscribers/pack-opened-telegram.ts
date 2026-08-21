import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { postApexPull, type ApexPullEvent } from '../modules/packs/telegram';

// Post-commit subscriber for `pack.opened` — one event per pull, emitted by
// BOTH open-pack and open-batch (the batch workflow passes an array to
// emitEventStep, which fans out to one event per element, same payload).
//
// Forwarder only: every gate (rarity bar, source, disabled player) and the
// send itself live in modules/packs/telegram.ts. postApexPull never throws —
// see its header for why a retry here would mean a duplicate public post.
export default async function packOpenedTelegramHandler({
  event: { data },
  container,
}: SubscriberArgs<ApexPullEvent>) {
  await postApexPull(container, data);
}

export const config: SubscriberConfig = {
  event: 'pack.opened',
};
