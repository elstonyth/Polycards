import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { postApexPull } from '../modules/packs/telegram';

// Telegram apex-board pre-flight — the same gap check-globepay.ts closes for
// payments. It exercises the ENTIRE integration end to end (odds lookup →
// rarity gate → source gate → disabled gate → card/pack/customer/FX joins →
// caption → live Telegram API call) without waiting for someone to actually
// roll a Legendary, which is the whole reason this path is otherwise untestable.
//
//   medusa exec ./src/scripts/telegram-apex-smoke.ts
//
// Picks a REAL apex (pack, card) pair and a REAL customer from the catalog,
// inserts a temporary Pull row, posts it, then deletes the row again. Nothing
// durable is left behind — but the Telegram post IS real and stays in the
// channel, so run it against a test channel or delete the post afterwards.
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
  const odds = apexOdds.find((o) => o.card_id === (cdnCard ?? cards[0])?.handle);
  const card = cdnCard ?? cards[0];
  if (!odds || !card) {
    logger.error('No Legendary/Immortal odds row in this catalog — cannot test.');
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
    await postApexPull(container, {
      pull_id: pull.id,
      pack_id: odds.pack_id,
      card_id: card.handle,
      customer_id: customer.id,
    });
    logger.info(
      '[telegram-smoke] done — check the channel. No post means a gate rejected it (see warnings above).',
    );
  } finally {
    await packs.deletePulls([pull.id]);
  }
}
