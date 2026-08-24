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
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';

// Telegram "apex pull" board — posts every Legendary-or-better pull to the
// public POLYCARDS.GG channel, so the community sees the big hits land in real
// time. Fed by the `pull.revealed` event via subscribers/pull-revealed-telegram
// .ts — the FLIP, not the roll. It hung off `pack.opened` until 2026-08-24,
// which fires when the roll commits: the channel named the card while the
// player's reels were still spinning.
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
  // Once per process, not per reveal: this runs on EVERY pull.revealed, and a
  // line per reveal would bury the thing it is trying to report. Silence here
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

/** Clip an already-HTML-escaped, tag-free field to `max` visible-ish chars
 *  without bisecting an entity. Fields carry entities (&amp; &lt; &gt;
 *  &quot;) but NO tags — tags are added by buildApexCaption around these
 *  clipped values — so the only hazard is cutting mid-entity, which we undo
 *  by trimming back to before a trailing `&` that has no following `;`. */
function clipEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max);
  const amp = cut.lastIndexOf('&');
  if (amp !== -1 && !cut.slice(amp).includes(';')) cut = cut.slice(0, amp);
  return `${cut}…`;
}

// SCAFFOLD_MAX / PER_FIELD together make the final CAPTION_LIMIT clamp below
// unreachable-by-construction instead of a blind slice: every field is
// escaped THEN clipped (clipEscaped, entity-aware) before it goes into a tag,
// so the assembled caption can never bisect a `<b>`/`<a>` tag or an entity.
//
// SCAFFOLD_MAX reserves room for everything in buildApexCaption that is NOT
// one of the five clipped fields (who, cardName, grade, set, packTitle):
// the fixed template text (emoji — surrogate pairs, 2 UTF-16 units each —
// tags, labels, newlines, the conditional ` · ` grade separator and the
// conditional whole `🃏` set line), PLUS the three other inputs that are
// deliberately left UNCLIPPED: the uppercased rarity tier, the formatted
// price, and profileUrl/siteUrl (operator config — a clipped URL is broken,
// so these are exactly what the reserve is for, not the fields).
//
// Measured empirically (not hand-counted — the emoji are surrogate pairs),
// 2026-08-22: assembling the caption with who/cardName/packTitle = '' (they
// contribute 0 via clipEscaped), grade = set = 'x' (1 char each, just to
// force BOTH conditional branches on), rarity = 'Legendary' (the longer of
// the two apex tiers that can reach this function, ties 'Immortal' at
// uppercase length 9), a 7-figure MYR price, and a 90-char profileUrl
// (default site origin + '/profile/' + a 60-char handle — HANDLE_RE's own
// max; deriveHandle's real ceiling is 45) measured 317 total; subtracting
// the 2 placeholder chars from grade/set gives a fixed cost of 315. The
// 'scaffolding stays inside SCAFFOLD_MAX' spec in telegram.unit.spec.ts
// re-measures this on every run — it is the drift guard if anyone adds a
// caption line, and it fails long before the inequality below could stop
// closing.
export const SCAFFOLD_MAX = 360;
// clipEscaped appends '…' on a clip, so a clipped field can be PER_FIELD + 1
// chars, and there are 5 fields — hence "- 5" below reserves one ellipsis
// per field, not a spare character. Closes with margin: 5*(131+1) + 360 =
// 1020 <= 1024.
const PER_FIELD = Math.floor((CAPTION_LIMIT - SCAFFOLD_MAX - 5) / 5); // 131

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

/**
 * Strip link-SHAPED text from a customer-controlled display name.
 *
 * escapeHtml above stops a customer writing `<a href>` into the caption, but it
 * does not stop Telegram writing one FOR them: under `parse_mode: HTML` the
 * client still auto-detects bare URLs, bare domains and `@mentions` in the text
 * and renders them clickable. So a first_name of `cheap-cards.example` arrives
 * in the official channel as a live link to a competitor or a phishing page —
 * escaped, well-formed, and exactly as dangerous as the tag we blocked.
 * `link_preview_options.is_disabled` does not help: it suppresses the preview
 * CARD, not the anchor, and it is only set on the sendMessage fallback anyway.
 *
 * Applied to `who` ONLY — the one field an untrusted party writes. Card, pack
 * and set names are admin-set, and a name legitimately containing a dot
 * ("Ho-Oh V .5") should not be silently mangled on the operator's behalf.
 *
 * Conservative by construction: the TLD arm requires two or more trailing
 * letters, so ordinary initials ("J.R. Smith") are untouched.
 */
export function stripAutolinks(value: string): string {
  return (
    value
      // scheme URLs, including tg://
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
      // bare domains (with optional path), e.g. t.me/x or cheap-cards.example
      .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b(?:\/\S*)?/gi, ' ')
      // Telegram @mentions. Lookbehind, not `(^|\s)`: Telegram starts a mention
      // at any @ NOT preceded by a word character, so `(@evil)`, `hello,@evil`
      // and `[@evil]` are live mentions too and a whitespace-only boundary
      // leaves them intact. `bob@example` keeps its @ — a word char before it
      // means Telegram reads an email fragment, not a mention, and the domain
      // arm above already handles the case that has a real TLD.
      .replace(/(?<!\w)@\w+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
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
  // stripAutolinks BEFORE escapeHtml: it matches on the raw text, and an
  // already-escaped `&amp;` would give its `amp;` fragment to the domain arm.
  // A name that is nothing BUT a link degrades to the same 'Anonymous' the
  // customer-lookup failure path uses, rather than an empty <b></b>.
  const who = clipEscaped(
    escapeHtml(stripAutolinks(input.who) || 'Anonymous'),
    PER_FIELD,
  );
  const name = input.profileUrl
    ? `<a href="${escapeHtml(input.profileUrl)}">${who}</a>`
    : who;
  const price = input.priceMyr.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const cardName = clipEscaped(escapeHtml(input.cardName), PER_FIELD);
  const grade = clipEscaped(escapeHtml(input.grade.trim()), PER_FIELD);
  const set = clipEscaped(escapeHtml(input.set.trim()), PER_FIELD);
  const packTitle = clipEscaped(escapeHtml(input.packTitle), PER_FIELD);

  const lines = [
    `${emoji} <b>${tier} PULL</b> ${emoji}`,
    '',
    `🎉 Congratulations <b>${name}</b>!`,
    '',
    `💎 <b>${cardName}</b>${input.grade.trim() ? ` · ${grade}` : ''}`,
  ];
  if (input.set.trim()) lines.push(`🃏 ${set}`);
  lines.push(
    `🎰 Pulled from <b>${packTitle}</b>`,
    `💰 Market value <b>RM ${price}</b>`,
    '',
    `🔗 <a href="${escapeHtml(input.siteUrl)}">Open your own pack at polycards.gg</a>`,
  );

  // Belt-and-braces only: every field above is already bounded by
  // clipEscaped, so this is unreachable for any input the SCAFFOLD_MAX /
  // PER_FIELD budgets allow (see the comment on SCAFFOLD_MAX). It is NOT
  // relied on for HTML-safety — a raw slice here could still bisect a tag
  // or entity, which is exactly the bug the budgets above exist to avoid.
  const caption = lines.join('\n');
  return caption.length > CAPTION_LIMIT
    ? `${caption.slice(0, CAPTION_LIMIT - 1)}…`
    : caption;
}

type TelegramResult = {
  ok: boolean;
  description?: string;
  /** Telegram's rate-limit code (429) and the seconds it says to wait before
   *  retrying. Loosely typed — this is the one Telegram error shape
   *  postApexPull acts on; every other error path only reads `description`. */
  error_code?: number;
  parameters?: { retry_after?: number };
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

/** Exported for the live probe (telegram-live.unit.spec.ts), which has to
 *  exercise each send path SEPARATELY — sendApexPost returns on the first
 *  success and so hides which one actually carried the picture. */
export async function callTelegram(
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

/** A composite attempt: the JPEG bytes, or null plus the reason it failed. The
 *  reason exists because the caller's fallbacks are silent by design (a dropped
 *  backdrop must never cost the post), and silent fallbacks are undiagnosable
 *  from the outside — a text-only post looks identical whether the art was
 *  unreachable, undecodable, or oversized. sendApexPost forwards it to
 *  postApexPull, which owns the logger. */
export type PhotoComposite = { photo: Buffer | null; error?: string };

const reason = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Fetch the card art and composite it onto {@link PHOTO_BACKGROUND}, returning
 * JPEG bytes to upload. `photo: null` on ANY failure — an unreachable URL
 * (locally the art is a localhost URL), a non-image body, an oversized result —
 * because the caller's fallback is to hand Telegram the URL, which is exactly
 * the old behaviour. Never throws: a background colour must not be able to cost
 * us the post. The fetch itself is host-validated and redirect-checked
 * (fetchBytes, shared with bake-slab.ts's admin image fetch) rather than a bare
 * `fetch` — a blocked URL degrades to the URL photo fallback exactly like an
 * unreachable one.
 */
export async function blackBackedPhoto(url: string): Promise<PhotoComposite> {
  // fetchBytes is fail-closed and folds every cause into null — a blocked host,
  // a non-2xx, a redirect chain, a timeout, an over-cap body all look alike. Its
  // onFail sink is what separates "the CDN 404'd" from "egress is blocked",
  // which is the difference between one deploy cycle and two.
  let why = 'art fetch returned nothing';
  let bytes: Buffer | null;
  try {
    bytes = await fetchBytes(url, (r) => {
      why = r;
    });
  } catch (err) {
    return { photo: null, error: `art fetch threw: ${reason(err)}` };
  }
  if (!bytes) return { photo: null, error: `art fetch: ${why}` };
  try {
    const flattened = await sharp(bytes, {
      limitInputPixels: MAX_DECODE_PIXELS,
    })
      .flatten({ background: PHOTO_BACKGROUND })
      .jpeg({ quality: 90 })
      .toBuffer();
    return flattened.byteLength > PHOTO_UPLOAD_LIMIT
      ? {
          photo: null,
          error: `composite ${flattened.byteLength}B over the ${PHOTO_UPLOAD_LIMIT}B upload limit`,
        }
      : { photo: flattened };
  } catch (err) {
    return { photo: null, error: `composite failed: ${reason(err)}` };
  }
}

/** sendPhoto with the image as multipart bytes rather than a URL — the only
 *  way to control what transparency is composited onto, since Telegram gives
 *  no background option when it fetches the URL itself. */
/** Exported for the same reason as callTelegram above — the live probe posts a
 *  synthetic JPEG through it to tell a bad IMAGE apart from a bad transport.
 *  Not a general-purpose sender: sendApexPost owns the fallback order. */
export async function uploadApexPhoto(
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

/** Turn a rejected promise into an `ok: false` result instead of letting it
 *  escape as a throw. Used only on the two photo-send paths (below) so a
 *  network error, an `AbortSignal.timeout`, or a non-JSON 5xx body from an
 *  edge proxy degrades to the text fallback instead of skipping it — never
 *  on the final `sendMessage`, whose throw must keep propagating to
 *  postApexPull's catch. */
const attempt = async (p: Promise<TelegramResult>): Promise<TelegramResult> =>
  p.catch((err) => ({ ok: false, description: reason(err) }));

/** Which route actually carried the post.
 *
 *  'bytes' is the only healthy one. 'url' means Telegram fetched the art itself
 *  and flattened its transparency onto WHITE — the post has a picture, in the
 *  wrong backdrop, which is precisely the state #471 was written to end and
 *  precisely the state production was found in on 2026-08-24. It is a degraded
 *  success, so it must be distinguishable from both a healthy post and a
 *  text-only one; treating it as "fine, it has a photo" is how it went
 *  unnoticed. */
export type ApexPhotoPath = 'bytes' | 'url' | 'text';

/** A send, plus how it got there and what failed on the way. `photoError` is
 *  set on EVERY post that wanted the byte path and did not get it — INCLUDING
 *  the ones that still went out with a picture via the URL fallback. That is
 *  the case this exists for: `ok` is true, a picture is visible, and without
 *  this the composite can be dead for months with nothing to show for it. */
export type ApexSendResult = TelegramResult & {
  photoError?: string;
  photoPath: ApexPhotoPath;
};

/** Post as a photo when we have an image, else as text. Two photo paths, tried
 *  in order and BOTH tried on failure: the preferred one uploads bytes we
 *  flattened onto black ourselves; if the composite or its upload fails for any
 *  reason — including a thrown network/timeout error, not just a non-ok
 *  response — we hand Telegram the URL as before, so a broken byte path costs
 *  the backdrop, never the picture. (Before, a failed UPLOAD skipped the URL
 *  path entirely and went straight to text — the composite only had a fallback
 *  when it returned no bytes at all.) The text fallback then genuinely covers a
 *  failed photo entirely, thrown or not: locally the card image is a localhost
 *  URL Telegram cannot reach, and a silent drop would make the board look
 *  broken in dev. */
export async function sendApexPost(
  token: string,
  chatId: string,
  caption: string,
  photoUrl: string | null,
): Promise<ApexSendResult> {
  const failures: string[] = [];
  if (photoUrl) {
    const composite = await blackBackedPhoto(photoUrl);
    if (composite.error) failures.push(composite.error);
    if (composite.photo) {
      const upload = await attempt(
        uploadApexPhoto(token, chatId, caption, composite.photo),
      );
      if (upload.ok) return { ...upload, photoPath: 'bytes' };
      failures.push(`byte upload: ${upload.description ?? 'unknown error'}`);
    }
    const urlPhoto = await attempt(
      callTelegram(token, 'sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: 'HTML',
      }),
    );
    // Carries `failures` even though it SUCCEEDED. This return is the normal
    // production path when the composite is broken, so dropping the reasons
    // here would silence the diagnostic in exactly the case it was written for
    // and leave it firing only on a total photo failure.
    if (urlPhoto.ok)
      return { ...urlPhoto, ...photoErrorOf(failures), photoPath: 'url' };
    failures.push(`url photo: ${urlPhoto.description ?? 'unknown error'}`);
  }
  // Deliberately NOT wrapped in attempt(): a thrown text send must keep
  // propagating to postApexPull's catch. The rethrow carries the photo reasons
  // into that catch's message, which is otherwise the one path where the whole
  // trail is lost.
  let text: TelegramResult;
  try {
    text = await callTelegram(token, 'sendMessage', {
      chat_id: chatId,
      text: caption,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    throw failures.length
      ? new Error(
          `${reason(err)} (photo had already failed: ${failures.join('; ')})`,
        )
      : err;
  }
  return { ...text, ...photoErrorOf(failures), photoPath: 'text' };
}

/** Spread helper so an empty failure list leaves `photoError` ABSENT rather
 *  than present-and-undefined — callers branch on its presence. */
const photoErrorOf = (failures: string[]): { photoError?: string } =>
  failures.length ? { photoError: failures.join('; ') } : {};

export type ApexPostResult = {
  caption: string;
  /** Telegram's id for the post, so a caller can delete it again. Null when the
   *  send failed. */
  messageId: number | null;
  /** Why the byte path did not carry this post, when there was art to send.
   *  Undefined = the composite went out (or there was no art at all). Set even
   *  when a picture DID appear via the URL fallback. */
  photoError?: string;
  /** Which route carried it. Surfaced, not just logged, so the smoke pre-flight
   *  can fail on anything but 'bytes': a URL-fallback post and a text-only post
   *  are both `ok` posts, and reporting those as success is how the board ran
   *  on the fallback from #471 to 2026-08-24 without anyone noticing. */
  photoPath: ApexPhotoPath;
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
    const photoUrl = card.slab_image ?? card.image ?? null;
    let result = await sendApexPost(token, chatId, caption, photoUrl);
    // Accumulated, not read off the final result: the 429 branch below
    // REASSIGNS `result`, and a rate-limit is exactly when the photo reason is
    // worth keeping. Deduped — the same cause twice is one line.
    const photoErrors = new Set<string>();
    if (result.photoError) photoErrors.add(result.photoError);
    // A 429 means Telegram did NOT deliver the message, so exactly one retry
    // cannot duplicate a post — the no-duplicate-post rule above is about
    // redelivery on a THROW, which this branch never does. Bounded hard: one
    // retry, 5s ceiling, because this runs inside an event-bus worker slot
    // and must not back up under a rate-limit storm. Never extend this retry
    // to any other non-ok reason — every other failure is exactly the
    // "post dropped" case the doc comment above describes.
    if (!result.ok && result.error_code === 429) {
      const waitSec = Math.min(result.parameters?.retry_after ?? 1, 5);
      logWarn(
        container,
        `[telegram] apex post rate-limited for pull ${event.pull_id} — retrying once after ${waitSec}s`,
      );
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      result = await sendApexPost(token, chatId, caption, photoUrl);
      if (result.photoError) photoErrors.add(result.photoError);
    }
    if (!result.ok) {
      logWarn(
        container,
        `[telegram] apex post rejected for pull ${event.pull_id}: ${result.description ?? 'unknown error'}`,
      );
    }
    // A photo that fell through to text is an OK post — so it logs nothing
    // above, and the board quietly renders as a text-only channel with no
    // trace of why. Warn separately, with the reason each photo path gave.
    if (photoErrors.size) {
      // The wording tracks the FINAL path, never the accumulated failures.
      // Those failures can belong to a rate-limited FIRST attempt whose retry
      // then delivered the picture perfectly well, and reporting that as
      // "posted WITHOUT its picture" is a lie the reader can check against the
      // channel — which is how a real warn gets written off as noise.
      // 'url' is the trap in the other direction: the post DOES carry a
      // picture, just Telegram's white-flattened one instead of our composite,
      // so it must not read as a clean success either.
      const what =
        result.photoPath === 'bytes'
          ? 'delivered its picture on the retry, after an earlier attempt failed'
          : result.photoPath === 'url'
            ? 'fell back to the URL picture (Telegram white-flattens it; the black composite is broken)'
            : 'posted WITHOUT its picture';
      logWarn(
        container,
        `[telegram] apex post for pull ${event.pull_id} ${what} (${photoUrl}): ${[...photoErrors].join('; ')}`,
      );
    }
    return {
      caption,
      messageId: result.result?.message_id ?? null,
      ...(photoErrors.size ? { photoError: [...photoErrors].join('; ') } : {}),
      photoPath: result.photoPath,
    };
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
