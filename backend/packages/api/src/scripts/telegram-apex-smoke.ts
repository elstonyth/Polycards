import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { deleteApexPost, postApexPull } from '../modules/packs/telegram';

// Telegram apex-board pre-flight — the same gap check-globepay.ts closes for
// payments. It exercises the ENTIRE integration end to end (odds lookup →
// rarity gate → source gate → disabled gate → card/pack/customer/FX joins →
// caption → live Telegram API call) without waiting for someone to actually
// roll a Legendary, which is the whole reason this path is otherwise untestable.
//
//   medusa exec ./src/scripts/telegram-apex-smoke.ts
//
// Picks a REAL apex (pack, card) pair and a REAL customer from the catalog,
// inserts a temporary Pull row, posts it, then deletes BOTH the post and the
// row. Safe to run against the live customer-facing channel: subscribers see
// the post for a second or two at most. TELEGRAM_SMOKE_KEEP=1 leaves it up.
export default async function telegramApexSmoke({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve(PACKS_MODULE) as PacksModuleService;

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    logger.error(
      'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset — the board is off, nothing to smoke-test.',
    );
    return;
  }

  // An apex odds row whose card has a real (CDN-hosted) slab image: a
  // localhost image URL is one Telegram's servers cannot fetch, so it would
  // silently exercise only the text fallback and prove nothing about the photo
  // path that production actually uses.
  const apexOdds = await packs.listPackOdds(
    { rarity: ['Legendary', 'Immortal'] } as Parameters<
      typeof packs.listPackOdds
    >[0],
    { take: 200 },
  );
  const handles = [
    ...new Set(apexOdds.map((o) => o.card_id).filter((c): c is string => !!c)),
  ];
  const cards = await packs.listCards(
    { handle: handles },
    { take: handles.length },
  );
  const cdnCard = cards.find((c) => c.slab_image?.startsWith('https://'));
  const odds = apexOdds.find(
    (o) => o.card_id === (cdnCard ?? cards[0])?.handle,
  );
  const card = cdnCard ?? cards[0];
  if (!odds || !card) {
    logger.error(
      'No Legendary/Immortal odds row in this catalog — cannot test.',
    );
    return;
  }
  if (!cdnCard) {
    logger.warn(
      'No apex card has a CDN slab image — this run only proves the TEXT fallback, not sendPhoto.',
    );
  }

  const customers = container.resolve(Modules.CUSTOMER);
  const [customer] = await customers.listCustomers({}, { take: 1 });
  if (!customer) {
    logger.error('No customer in this database — cannot test.');
    return;
  }

  // A real Pull row, because postApexPull reads it for the source gate. Deleted
  // in the finally below so a smoke run never pollutes the feed/leaderboard.
  const [pull] = await packs.createPulls([
    {
      customer_id: customer.id,
      pack_id: odds.pack_id,
      card_id: card.handle,
      rolled_at: new Date(),
      source: 'pack',
    },
  ]);

  try {
    logger.info(
      `[telegram-smoke] posting ${odds.rarity} ${card.handle} from ${odds.pack_id} as ${customer.id}`,
    );
    const posted = await postApexPull(container, {
      pull_id: pull.id,
      pack_id: odds.pack_id,
      card_id: card.handle,
      customer_id: customer.id,
    });
    if (!posted) {
      logger.error(
        '[telegram-smoke] nothing built — a gate rejected this pull (rarity, source, or a disabled player).',
      );
      return;
    }

    // Printed whether or not Telegram accepted it: a rejected send logs its own
    // warn above, and seeing the rendered text is the whole point of a
    // pre-flight — especially when the send is the broken part.
    logger.info(`[telegram-smoke] caption:\n${posted.caption}`);

    // Take the test post straight back down. The default is DELETE, not keep:
    // this runs against the live customer-facing channel, and a pre-flight that
    // leaves marketing debris in front of real subscribers is a worse pre-flight
    // than one that proves nothing. Set TELEGRAM_SMOKE_KEEP=1 to leave it up.
    if (posted.messageId === null) return;
    if (process.env.TELEGRAM_SMOKE_KEEP === '1') {
      logger.warn(
        `[telegram-smoke] TELEGRAM_SMOKE_KEEP=1 — message ${posted.messageId} LEFT UP in the channel.`,
      );
      return;
    }
    const removed = await deleteApexPost(
      process.env.TELEGRAM_BOT_TOKEN!,
      process.env.TELEGRAM_CHAT_ID!,
      posted.messageId,
    );
    if (removed.ok) {
      logger.info(
        `[telegram-smoke] test post ${posted.messageId} deleted — channel is clean.`,
      );
    } else {
      // Loud, and with the id: an undeleted post is visible to every subscriber
      // and someone has to remove it by hand.
      logger.error(
        `[telegram-smoke] COULD NOT DELETE message ${posted.messageId} (${removed.description ?? 'unknown error'}) — remove it manually.`,
      );
    }
  } finally {
    await packs.deletePulls([pull.id]);
  }
}
