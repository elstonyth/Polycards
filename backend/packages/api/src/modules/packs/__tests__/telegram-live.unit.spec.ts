import sharp from 'sharp';
import {
  blackBackedPhoto,
  buildApexCaption,
  callTelegram,
  deleteApexPost,
  uploadApexPhoto,
} from '../telegram';

/**
 * LIVE probe for the Telegram apex board's picture — opt-in, skipped by default.
 *
 * Why this exists: the board posted text-only for its entire life (every apex
 * post from #469 to 2026-08-24) and nothing said so. `sendApexPost` degrades to
 * `sendMessage`, which returns ok, so the post "succeeded" while the picture
 * silently vanished — and the only way to observe it was to wait for someone to
 * roll a Legendary and then look at the channel with your own eyes. This turns
 * that into a command.
 *
 * It exercises EACH send path separately against the REAL Telegram API, because
 * `sendApexPost` returns on the first success and so hides which one actually
 * carried the picture:
 *
 *   1. getMe                      — token valid, bot reachable
 *   2. blackBackedPhoto           — can THIS host fetch the art and composite it
 *   3a. sendPhoto (synthetic JPEG) — transport + chat media rights, no art
 *   3b. sendPhoto (bytes, JPEG)    — the preferred path
 *   4. sendPhoto (URL, usually .webp) — the fallback path
 *   5. sendMessage                — the text floor
 *
 * Every message it posts is deleted again. Run it after ANY change to the board,
 * and after a deploy that could move the runtime (Node version, base image,
 * egress rules) — the failure it was written for was invisible to every unit
 * test in this suite because the mocks accept payloads Telegram may not.
 *
 * Put both values in this package's local env file (jest.config's
 * loadEnv('test') reads .env.test AND .env), so the token never lands in a
 * command line or a shell history:
 *
 *   TELEGRAM_BOT_TOKEN=<token>
 *   TELEGRAM_PROBE_CHAT_ID=<a chat YOU control>
 *
 * then, from backend/packages/api:
 *
 *   corepack yarn telegram:probe
 *
 * TELEGRAM_PROBE_CHAT_ID is deliberately NOT TELEGRAM_CHAT_ID: this posts four
 * throwaway messages, and a delete does not un-send a push notification. Point
 * it at a scratch group (add the bot, make it an admin) or your own DM with the
 * bot — never the public channel.
 *
 * Only step 2 is HOST-specific — it is the one that touches the CDN from wherever
 * you run it. Steps 3-5 send identical payloads to api.telegram.org from
 * anywhere, so a laptop run answers the Telegram-side questions definitively; a
 * green step 2 there says nothing about whether the prod worker can reach the
 * CDN. Run it on the box that posts to answer that.
 *
 * TELEGRAM_PROBE_IMAGE_URL overrides the art. Default is a real prod CDN slab,
 * i.e. exactly the kind of URL the board posts: a transparent .webp.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_PROBE_CHAT_ID;
const imageUrl =
  process.env.TELEGRAM_PROBE_IMAGE_URL ??
  'https://polycards-media.sgp1.cdn.digitaloceanspaces.com/slab-reshiram-ex-168-psa-10-9692093-3a9bccdf-01KZP00GYWTKBDN14JN04FMTZ0.webp';

// Skipped, not failed, when unconfigured: this file sits in the normal unit
// tier so it is discoverable and type-checked on every run, and CI has no
// business posting to Telegram.
const live = token && chatId ? describe : describe.skip;

// Network + Telegram round trips, not the ~5s unit default.
jest.setTimeout(120_000);

// Finding a chat id is the one genuinely annoying prerequisite (Telegram shows
// it nowhere in the UI), and "I couldn't get the id" is how a diagnostic tool
// ends up never being run. With a token but no chat, list the chats that have
// recently messaged the bot instead of just skipping.
const discover = token && !chatId ? describe : describe.skip;
discover('LIVE Telegram probe — chat id lookup', () => {
  it('lists chats that recently messaged the bot', async () => {
    const updates = (await callTelegram(token!, 'getUpdates', {})) as {
      ok: boolean;
      result?: {
        message?: {
          chat?: {
            id: number;
            type: string;
            title?: string;
            username?: string;
          };
        };
      }[];
    };
    const chats = new Map<number, string>();
    for (const u of updates.result ?? []) {
      const c = u.message?.chat;
      if (c) chats.set(c.id, `${c.type} ${c.title ?? c.username ?? ''}`.trim());
    }
    console.log(
      chats.size
        ? `[probe] set TELEGRAM_PROBE_CHAT_ID to one of:\n${[...chats]
            .map(([id, label]) => `  ${id}  (${label})`)
            .join('\n')}`
        : '[probe] no chats listed. FIRST check whether a webhook is set (getWebhookInfo) — a webhook makes getUpdates return nothing at all, no matter how many messages the bot got. Otherwise: send the bot a message (or post in the scratch group) and re-run; getUpdates only sees the last 24h.',
    );
  });
});

live('LIVE Telegram apex photo probe', () => {
  const caption = buildApexCaption({
    who: 'Probe',
    profileUrl: null,
    rarity: 'Legendary',
    cardName: 'Photo path probe',
    grade: 'PSA 10',
    set: 'Not a real pull — safe to delete',
    packTitle: 'Probe Pack',
    priceMyr: 1,
    siteUrl: 'https://polycards.gg',
  });
  // Every finding is printed, never only asserted: the point of the run is the
  // reason string Telegram gives back, and a bare "expected true, got false"
  // throws that away — which is the exact failure mode this file was written
  // for. The expects come after, so a red run still leaves the diagnosis on
  // screen.
  const say = (line: string): void => console.log(`[probe] ${line}`);
  const cleanup: number[] = [];

  afterAll(async () => {
    for (const id of cleanup) {
      const gone = await deleteApexPost(token!, chatId!, id);
      if (!gone.ok) {
        say(
          `COULD NOT DELETE message ${id}: ${gone.description ?? 'unknown'} — remove it by hand.`,
        );
      }
    }
  });

  it('1. reaches Telegram with a valid token', async () => {
    const me = await callTelegram(token!, 'getMe', {});
    say(`getMe: ${JSON.stringify(me)}`);
    expect(me.ok).toBe(true);
  });

  it('2. fetches the art and composites it onto black', async () => {
    const composite = await blackBackedPhoto(imageUrl);
    say(
      composite.photo
        ? `composite ok: ${composite.photo.byteLength} bytes of JPEG`
        : `composite FAILED: ${composite.error}`,
    );
    // A failure here is local to THIS host — egress, DNS, the SSRF allowlist,
    // sharp — and says nothing about Telegram. Run it on the box that actually
    // posts (the worker) before concluding anything about the CDN.
    expect(composite.error).toBeUndefined();
  });

  // Isolates the variable step 3 alone cannot: if a trivial JPEG we built
  // ourselves uploads and the composited slab does not, the problem is that
  // IMAGE. If neither uploads while step 5's text does, the problem is the
  // multipart path or this chat's media rights — nothing to do with the art.
  it('3a. accepts a synthetic JPEG upload (isolates the image from the transport)', async () => {
    const solid = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 20, g: 20, b: 20 },
      },
    })
      .jpeg()
      .toBuffer();
    const result = await uploadApexPhoto(
      token!,
      chatId!,
      'probe: synthetic',
      solid,
    );
    say(`synthetic upload: ${JSON.stringify(result)}`);
    if (result.result?.message_id) cleanup.push(result.result.message_id);
    expect(result.ok).toBe(true);
  });

  it('3b. accepts the real picture as an uploaded JPEG (the preferred path)', async () => {
    const composite = await blackBackedPhoto(imageUrl);
    if (!composite.photo) {
      say('skipped: no composite bytes (see step 2)');
      return;
    }
    const result = await uploadApexPhoto(
      token!,
      chatId!,
      caption,
      composite.photo,
    );
    say(`byte upload: ${JSON.stringify(result)}`);
    if (result.result?.message_id) cleanup.push(result.result.message_id);
    expect(result.ok).toBe(true);
  });

  it('4. reports whether Telegram will fetch the art URL itself (the fallback path)', async () => {
    const result = await callTelegram(token!, 'sendPhoto', {
      chat_id: chatId,
      photo: imageUrl,
      caption,
      parse_mode: 'HTML',
    });
    say(`url photo: ${JSON.stringify(result)}`);
    if (result.result?.message_id) cleanup.push(result.result.message_id);
    // NOT asserted. Telegram's URL fetcher is documented as JPEG/PNG/GIF and
    // our slabs are .webp, so a refusal here is expected and harmless — the
    // byte path in step 3 is the one that has to hold. This step exists to
    // record WHICH of the two Telegram refuses, which is the whole question
    // when the channel goes text-only again.
  });

  it('5. can always fall back to text', async () => {
    const result = await callTelegram(token!, 'sendMessage', {
      chat_id: chatId,
      text: caption,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    say(`text: ${JSON.stringify(result)}`);
    if (result.result?.message_id) cleanup.push(result.result.message_id);
    expect(result.ok).toBe(true);
  });
});
