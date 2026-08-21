import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import { rarityRank, type Rarity } from './rarity';
import { toMoney } from './money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from './pricing';

// Telegram "apex pull" board — posts every Legendary-or-better pull to the
// public POLYCARDS.GG channel, so the community sees the big hits land in real
// time. Fed by the `pack.opened` event (one per pull, from BOTH open-pack and
// open-batch), via subscribers/pack-opened-telegram.ts.
//
// Config is env-only, so an unconfigured environment (dev, CI, integration
// tests) is a silent no-op rather than a failure or a stray post:
//   TELEGRAM_BOT_TOKEN   bot token from @BotFather. Absent -> feature off.
//   TELEGRAM_CHAT_ID     numeric channel id (e.g. -1003945115527). Prefer the
//                        numeric id over @username: it survives a rename.
//   TELEGRAM_MIN_RARITY  lowest tier that gets posted. Default 'Legendary'
//                        (= Legendary + Immortal). NOTE the repo's RARITY_ORDER
//                        puts Mythical BELOW Legendary — set this to 'Mythical'
//                        to widen the board by one tier.
//   TELEGRAM_SITE_URL    storefront origin for the profile link.
//                        Default https://polycards.gg.

const TELEGRAM_API = 'https://api.telegram.org';

/** Pull origins that never reach a public surface. 'reward' is a private vault
 *  prize (same stance as /store/pulls/recent). 'free' — the welcome pack — IS
 *  posted on purpose: it is the signup hook the channel markets, and a big
 *  free-pack hit is the best ad for it. Move 'free' in here to suppress those. */
const EXCLUDED_SOURCES: readonly string[] = ['reward'];

const DEFAULT_MIN_RARITY: Rarity = 'Legendary';
const DEFAULT_SITE_URL = 'https://polycards.gg';

/** Telegram caption limit for sendPhoto. Ours is far shorter; the clamp only
 *  exists so a pathological card/pack name can never 400 the whole post. */
const CAPTION_LIMIT = 1024;

/** Telegram's `parse_mode: HTML` needs these escaped. first_name and the
 *  profile handle are customer-controlled at signup, so an unescaped caption
 *  would let a customer inject markup (or a link) into a public marketing
 *  channel. Card/pack/set names come from the admin, but are escaped too —
 *  one rule, no call site left to remember it. */
export function escapeHtml(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Not required by Telegram's parser, but `&quot;` is one of the four
      // entities it accepts, and escaping it makes href-attribute injection
      // impossible by construction rather than by argument.
      .replace(/"/g, '&quot;')
  );
}

/** Apex tiers get their own crown; everything else rides the star. */
const rarityEmoji = (rarity: string): string =>
  rarity === 'Immortal' ? '👑' : '🌟';

export type ApexCaptionInput = {
  /** Public display name — profile handle, else first name, else 'Anonymous'. */
  who: string;
  /** Absolute profile URL, or null when the puller has no handle yet. */
  profileUrl: string | null;
  rarity: string;
  cardName: string;
  /** e.g. "PSA 10". Empty for raw (ungraded) cards. */
  grade: string;
  /** Card set / expansion, e.g. "ME02: Phantasmal Flames". */
  set: string;
  packTitle: string;
  /** Display market value in MYR (already FX + multiplier applied). */
  priceMyr: number;
  siteUrl: string;
};

/** The posted message. Pure — every lookup happens in postApexPull, so the
 *  wording is unit-testable and safe to re-tune without touching the DB path. */
export function buildApexCaption(input: ApexCaptionInput): string {
  const emoji = rarityEmoji(input.rarity);
  const tier = input.rarity.toUpperCase();
  const who = escapeHtml(input.who);
  const name = input.profileUrl
    ? `<a href="${escapeHtml(input.profileUrl)}">${who}</a>`
    : who;
  const price = input.priceMyr.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const lines = [
    `${emoji} <b>${tier} PULL</b> ${emoji}`,
    '',
    `🎉 Congratulations <b>${name}</b>!`,
    '',
    `💎 <b>${escapeHtml(input.cardName)}</b>${
      input.grade.trim() ? ` · ${escapeHtml(input.grade.trim())}` : ''
    }`,
  ];
  if (input.set.trim()) lines.push(`🃏 ${escapeHtml(input.set.trim())}`);
  lines.push(
    `🎰 Pulled from <b>${escapeHtml(input.packTitle)}</b>`,
    `💰 Market value <b>RM ${price}</b>`,
    '',
    `🔗 <a href="${escapeHtml(input.siteUrl)}">Open your own pack at polycards.gg</a>`,
  );

  const caption = lines.join('\n');
  return caption.length > CAPTION_LIMIT
    ? `${caption.slice(0, CAPTION_LIMIT - 1)}…`
    : caption;
}

type TelegramResult = { ok: boolean; description?: string };

async function callTelegram(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResult> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as TelegramResult;
}

/** Post as a photo when we have an image Telegram's servers can fetch, else as
 *  text. The text fallback also covers the failed-photo case: locally the card
 *  image is a localhost URL Telegram cannot reach, and a silent drop there
 *  would make the whole board look broken in dev. */
export async function sendApexPost(
  token: string,
  chatId: string,
  caption: string,
  photoUrl: string | null,
): Promise<TelegramResult> {
  if (photoUrl) {
    const photo = await callTelegram(token, 'sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
    });
    if (photo.ok) return photo;
  }
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: caption,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export type ApexPullEvent = {
  pull_id: string;
  pack_id: string; // = Pack.slug
  card_id: string; // = Card.handle
  customer_id: string;
};

const logWarn = (
  container: { resolve: (k: string) => any },
  message: string,
): void => {
  try {
    container.resolve(ContainerRegistrationKeys.LOGGER).warn(message);
  } catch {
    // logger not available (unit-test container) — stay silent, never throw.
  }
};

/**
 * Post one pull to the Telegram board if it clears the rarity bar.
 *
 * NEVER throws. A throw here would be re-delivered by the Medusa event bus,
 * and Telegram has no dedupe — a retry is a DUPLICATE PUBLIC POST, which is
 * worse than a dropped one. The pull itself is already committed either way.
 */
export async function postApexPull(
  container: { resolve: (k: string) => any },
  event: ApexPullEvent,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // feature off (dev / CI / tests)

  try {
    const packs = container.resolve(PACKS_MODULE) as PacksModuleService;

    // 1. Rarity gate FIRST — it rejects the overwhelming majority of opens for
    //    the cost of one indexed lookup, so the common path stays cheap.
    //    Rarity is per-(pack, card): the same card is a different tier in
    //    another pack. A missing odds row degrades to Common = not posted.
    const [odds] = await packs.listPackOdds(
      { pack_id: event.pack_id, card_id: event.card_id },
      { take: 1 },
    );
    const rarity = odds?.rarity ?? 'Common';
    const minRarity =
      process.env.TELEGRAM_MIN_RARITY?.trim() || DEFAULT_MIN_RARITY;
    if (rarityRank(rarity) > rarityRank(minRarity)) return;

    // 2. Source gate — private vault prizes never go public.
    const [pull] = await packs.listPulls({ id: event.pull_id }, { take: 1 });
    if (!pull || EXCLUDED_SOURCES.includes(pull.source)) return;

    // 3. An administratively disabled player is hidden from every public
    //    surface (the leaderboard/feed rule). A Telegram post is far less
    //    retractable than a feed row, so this gate matters more here.
    const disabled = await packs.disabledCustomerIds([event.customer_id]);
    if (disabled.has(event.customer_id)) return;

    const [[card], [pack], fxRate] = await Promise.all([
      packs.listCards({ handle: event.card_id }, { take: 1 }),
      packs.listPacks({ slug: event.pack_id }, { take: 1 }),
      resolveFxRate(packs),
    ]);
    if (!card) return; // card removed since the roll — nothing to show

    // Public identity: the profile handle when the customer has one (it is
    // already public and links to /profile/<handle>), else the full first name
    // — the same field the leaderboard and live feed show. Never email, never
    // customer_id. A customer-module failure degrades to 'Anonymous'.
    const siteUrl = (
      process.env.TELEGRAM_SITE_URL?.trim() || DEFAULT_SITE_URL
    ).replace(/\/+$/, '');
    let who = 'Anonymous';
    let profileUrl: string | null = null;
    try {
      const customers = container.resolve(Modules.CUSTOMER);
      const customer = await customers.retrieveCustomer(event.customer_id);
      const handle = (customer.metadata as Record<string, unknown> | null)
        ?.handle;
      if (typeof handle === 'string' && handle.trim()) {
        who = handle.trim();
        profileUrl = `${siteUrl}/profile/${encodeURIComponent(who)}`;
      } else if (customer.first_name?.trim()) {
        who = customer.first_name.trim();
      }
    } catch {
      // customer module unavailable — post it anonymously rather than not at all
    }

    // Same price the storefront shows for this card (FX × the card's own
    // display multiplier). Mirrors /store/pulls/recent exactly: a caption that
    // disagreed with the site would be a credibility bug on a public channel.
    const priceMyr = displayMarketPrice(
      toMoney(card.market_value),
      fxRate,
      Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
    );

    const caption = buildApexCaption({
      who,
      profileUrl,
      rarity,
      cardName: card.name,
      grade: [card.grader, card.grade].filter((s) => s?.trim()).join(' '),
      set: card.set ?? '',
      packTitle: pack?.title ?? event.pack_id,
      priceMyr,
      siteUrl,
    });

    // The baked slab is the hero image; raw cards fall back to the bare photo.
    const result = await sendApexPost(
      token,
      chatId,
      caption,
      card.slab_image ?? card.image ?? null,
    );
    if (!result.ok) {
      logWarn(
        container,
        `[telegram] apex post rejected for pull ${event.pull_id}: ${result.description ?? 'unknown error'}`,
      );
    }
  } catch (err) {
    logWarn(
      container,
      `[telegram] apex post failed for pull ${event.pull_id} — pull committed, post dropped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
