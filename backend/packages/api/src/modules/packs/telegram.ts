import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import sharp from 'sharp';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import { RARITY_ORDER, rarityRank, type Rarity } from './rarity';
import { toMoney } from './money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from './pricing';
import { publicProfileFields, seedOf } from '../../utils/profile-handle';

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

/**
 * The lowest tier that gets posted. FAIL-CLOSED on an unrecognised value, and
 * that is load-bearing rather than tidy: rarityRank() returns RARITY_ORDER.length
 * for an unknown tier, so a typo'd bar ('legendary', 'Mythic', a stray space
 * surviving a paste into the DO console) would rank BELOW Common and turn the
 * gate into `every tier <= 6` — i.e. every single pack open posting to a public
 * marketing channel. Anything not exactly in RARITY_ORDER falls back to the
 * default instead.
 */
let minRarityWarned = false;

/** Test seam: module state outlives a test's fixtures (one jest process is one
 *  module instance), so the once-only warn would not fire for the next spec. */
export function resetTelegramWarnings(): void {
  minRarityWarned = false;
}

const minRarity = (container: { resolve: (k: string) => any }): Rarity => {
  const configured = process.env.TELEGRAM_MIN_RARITY?.trim();
  if (!configured) return DEFAULT_MIN_RARITY;
  if (RARITY_ORDER.includes(configured as Rarity)) return configured as Rarity;
  // Once per process, not per open: this runs on EVERY pack.opened, and a line
  // per pack open would bury the thing it is trying to report. Silence here
  // would be worse than noise though — the fallback is invisible from the
  // outside, so a typo'd bar looks exactly like a quiet week of no apex pulls.
  if (!minRarityWarned) {
    minRarityWarned = true;
    logWarn(
      container,
      `[telegram] TELEGRAM_MIN_RARITY="${configured}" is not one of ${RARITY_ORDER.join(', ')} — falling back to ${DEFAULT_MIN_RARITY}.`,
    );
  }
  return DEFAULT_MIN_RARITY;
};
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
  /** Public display name — first name, else the anonymous "Collector ####"
   *  (or 'Anonymous' when the customer lookup itself failed). NOT the handle:
   *  that is only the link target (see postApexPull). */
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

type TelegramResult = {
  ok: boolean;
  description?: string;
  /** Telegram's own payload. Only message_id is read — it is what lets an
   *  operator (or the pre-flight script) delete one specific post again. */
  result?: { message_id?: number };
};

/** Remove a post the bot made. The board itself never calls this: it exists so
 *  telegram-apex-smoke.ts can verify against the LIVE customer-facing channel
 *  and take its own test post straight back down. Requires the bot to hold
 *  "Delete Messages" in the channel, which the same admin grant gives it. */
export async function deleteApexPost(
  token: string,
  chatId: string,
  messageId: number,
): Promise<TelegramResult> {
  return callTelegram(token, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

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

/** Backdrop the slab art is composited onto before it is posted. Telegram
 *  flattens any transparency onto WHITE, and a baked slab is ~1/3
 *  semi-transparent glass, so a URL-sent slab arrives wrapped in a white box —
 *  wrong against both the channel's dark theme and the storefront, which
 *  renders the same art on a dark ground. */
const PHOTO_BACKGROUND = '#000000';

/** Telegram's own upload ceiling for a multipart sendPhoto. Ours are ~200 KB;
 *  the guard only exists so an unexpectedly huge asset falls back to the URL
 *  path (where Telegram fetches and downscales it itself) instead of eating a
 *  413 and dropping to text. */
const PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024;

/**
 * Fetch the card art and composite it onto {@link PHOTO_BACKGROUND}, returning
 * JPEG bytes to upload. Null on ANY failure — an unreachable URL (locally the
 * art is a localhost URL), a non-image body, an oversized result — because the
 * caller's fallback is to hand Telegram the URL, which is exactly the old
 * behaviour. Never throws: a background colour must not be able to cost us the
 * post.
 */
export async function blackBackedPhoto(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const flattened = await sharp(Buffer.from(await res.arrayBuffer()))
      .flatten({ background: PHOTO_BACKGROUND })
      .jpeg({ quality: 90 })
      .toBuffer();
    return flattened.byteLength > PHOTO_UPLOAD_LIMIT ? null : flattened;
  } catch {
    return null;
  }
}

/** sendPhoto with the image as multipart bytes rather than a URL — the only
 *  way to control what transparency is composited onto, since Telegram gives
 *  no background option when it fetches the URL itself. */
async function uploadApexPhoto(
  token: string,
  chatId: string,
  caption: string,
  photo: Buffer,
): Promise<TelegramResult> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'pull.jpg');
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
    // Longer than the JSON calls: this one carries the image itself.
    signal: AbortSignal.timeout(30_000),
  });
  return (await res.json()) as TelegramResult;
}

/** Post as a photo when we have an image, else as text. Two photo paths: the
 *  preferred one uploads bytes we flattened onto black ourselves; if that
 *  fails for any reason we hand Telegram the URL as before, so a broken
 *  composite step costs the backdrop, never the post. The text fallback then
 *  covers a failed photo entirely: locally the card image is a localhost URL
 *  Telegram cannot reach, and a silent drop would make the board look broken
 *  in dev. */
export async function sendApexPost(
  token: string,
  chatId: string,
  caption: string,
  photoUrl: string | null,
): Promise<TelegramResult> {
  if (photoUrl) {
    const bytes = await blackBackedPhoto(photoUrl);
    const photo = bytes
      ? await uploadApexPhoto(token, chatId, caption, bytes)
      : await callTelegram(token, 'sendPhoto', {
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

export type ApexPostResult = {
  caption: string;
  /** Telegram's id for the post, so a caller can delete it again. Null when the
   *  send failed. */
  messageId: number | null;
};

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
 *
 * Returns the caption it built and attempted to send plus the resulting
 * Telegram message id, or null when a gate
 * rejected the pull (or an error was thrown). A send FAILURE still returns the
 * caption — it is logged separately, and the pre-flight's whole job is to show
 * the real rendered text, which is exactly what you need to see when the send
 * is the thing that is broken; messageId is null in that case. The subscriber
 * ignores the return value.
 */
export async function postApexPull(
  container: { resolve: (k: string) => any },
  event: ApexPullEvent,
): Promise<ApexPostResult | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null; // feature off (dev / CI / tests)

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
    if (rarityRank(rarity) > rarityRank(minRarity(container))) return null;

    // 2. Source gate — private vault prizes never go public.
    const [pull] = await packs.listPulls({ id: event.pull_id }, { take: 1 });
    if (!pull || EXCLUDED_SOURCES.includes(pull.source)) return null;

    // 3. An administratively disabled player is hidden from every public
    //    surface (the leaderboard/feed rule). A Telegram post is far less
    //    retractable than a feed row, so this gate matters more here.
    const disabled = await packs.disabledCustomerIds([event.customer_id]);
    if (disabled.has(event.customer_id)) return null;

    const [[card], [pack], fxRate] = await Promise.all([
      packs.listCards({ handle: event.card_id }, { take: 1 }),
      packs.listPacks({ slug: event.pack_id }, { take: 1 }),
      resolveFxRate(packs),
    ]);
    if (!card) return null; // card removed since the roll — nothing to show

    // Public identity: the SAME name/handle split every other public surface
    // uses (publicProfileFields — leaderboard, weekly challenge, profile page).
    // The NAME is first_name, else the anonymous "Collector ####"; the handle
    // is only the /profile/<handle> link target. Never the other way round:
    // a handle is a slug of the name at signup and is NEVER re-derived on a
    // rename, so showing it as the display name announces a renamed customer
    // under the name they signed up with.
    // Never email, never customer_id. A customer-module failure degrades to
    // 'Anonymous'.
    const siteUrl = (
      process.env.TELEGRAM_SITE_URL?.trim() || DEFAULT_SITE_URL
    ).replace(/\/+$/, '');
    let who = 'Anonymous';
    let profileUrl: string | null = null;
    try {
      const customers = container.resolve(Modules.CUSTOMER);
      const customer = await customers.retrieveCustomer(event.customer_id);
      const profile = publicProfileFields(customer, seedOf(event.customer_id));
      who = profile.name;
      if (profile.handle) {
        profileUrl = `${siteUrl}/profile/${encodeURIComponent(profile.handle)}`;
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
    return { caption, messageId: result.result?.message_id ?? null };
  } catch (err) {
    logWarn(
      container,
      `[telegram] apex post failed for pull ${event.pull_id} — pull committed, post dropped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
