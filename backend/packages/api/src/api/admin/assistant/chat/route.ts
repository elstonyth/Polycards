import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import sharp from 'sharp';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { openKey } from '../../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor, allowedTools } from '../access';
import { runTurn } from '../engine';
import { storeImage } from '../images';
import { DEFAULT_IMAGE_STYLE, styleRefs } from '../brand-style';
import { memoryFor } from '../agent-tools';
import type { ChatMessage } from '../openrouter';
import { TOOLS } from '../tools';

// POST /admin/assistant/chat (spec 2026-10-29): one question, answered as a
// stream of newline-delimited JSON events, so staff watch the answer and the
// tool steps arrive:
//   conversation {id,title} · text {delta} · tool {id,name,label,status,ms}
//   image {url} · error {message} · done {message_id,cost_usd} · ping
// The headers go out at once and a ping every 10 s keeps proxies from
// timing the request out while a poster or a query runs. Read-only: the only
// rows written are the conversation and its messages.

const MAX_TEXT = 4000;
const MAX_IMAGES = 4;
// The admin shrinks a screenshot to 1600px JPEG (well under 1 MB) before it
// sends it; the body limit (middlewares.ts) is sized to 4 of these.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const HISTORY = 20;
// One turn at a time per staff member, so parallel questions cannot all
// pass the daily cap check before any of them has saved its cost. Per
// process: with the backend on 2 web instances a person can have at most
// 2 answers running, and each answer also stops at the cap (engine.ts).
const busy = new Set<string>();

const IMAGE_RE = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

type Body = { conversation_id?: unknown; message?: unknown; images?: unknown };

function parse(body: Body): {
  conversationId?: string;
  text: string;
  images: string[];
} {
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text) throw new Error('Type a question.');
  if (text.length > MAX_TEXT) {
    throw new Error(`A question is at most ${MAX_TEXT} characters.`);
  }
  const images = body.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    throw new Error(`Attach at most ${MAX_IMAGES} images.`);
  }
  for (const img of images) {
    const m = typeof img === 'string' ? IMAGE_RE.exec(img) : null;
    if (!m) throw new Error('Images must be PNG, JPEG or WebP.');
    if ((m[2].length * 3) / 4 > MAX_IMAGE_BYTES) {
      throw new Error('Each image must be 1.5 MB or smaller.');
    }
  }
  const id = body.conversation_id;
  if (id !== undefined && id !== null && typeof id !== 'string') {
    throw new Error('conversation_id must be a string.');
  }
  return { conversationId: id || undefined, text, images: images as string[] };
}

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  let input: ReturnType<typeof parse>;
  try {
    input = parse(req.body ?? {});
  } catch (err) {
    res.status(400).json({ message: (err as Error).message });
    return;
  }
  // Listening from the start: a person who leaves during the first awaits
  // must not leave an answer running (and paid for) behind them.
  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctl.abort();
  });
  const scope = req.scope;
  const assistant = scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const access = accessFor(scope, req.auth_context);

  let conversation: { id: string; title: string } | undefined;
  if (input.conversationId) {
    const [own] = await assistant.listAssistantConversations(
      { id: input.conversationId, user_id: access.userId },
      { take: 1 },
    );
    if (!own) {
      res.status(404).json({ message: 'That conversation was not found.' });
      return;
    }
    conversation = own;
  }

  const settings = await assistant.settings();
  const { http } = scope.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  const key = settings.openrouter_key_sealed
    ? openKey(settings.openrouter_key_sealed, http.jwtSecret as string)
    : null;

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const finish = (event?: Record<string, unknown>) => {
    if (event) send(event);
    if (!res.writableEnded) res.end();
  };

  if (!key) {
    finish({
      type: 'error',
      code: 'no_key',
      message: settings.openrouter_key_sealed
        ? 'The AI key can no longer be read (the server secret changed). An admin must enter it again in Settings → AI.'
        : 'The assistant has no AI key yet. An admin adds the OpenRouter key in Settings → AI.',
    });
    return;
  }
  if (busy.has(access.userId)) {
    finish({
      type: 'error',
      code: 'busy',
      message:
        'Your previous question is still being answered. Wait for it, then ask again.',
    });
    return;
  }
  busy.add(access.userId);
  const ping = setInterval(() => send({ type: 'ping' }), 10_000);
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER);

  try {
    const spent = await assistant.spentToday(access.userId);
    if (spent >= Number(settings.daily_cap_usd)) {
      finish({
        type: 'error',
        code: 'daily_cap',
        message: `You reached today's assistant limit (USD ${Number(settings.daily_cap_usd).toFixed(2)}). It resets at 00:00 Malaysia time.`,
      });
      return;
    }

    const now = new Date();
    if (!conversation) {
      conversation = (await assistant.createAssistantConversations({
        user_id: access.userId,
        title: input.text.replace(/\s+/g, ' ').slice(0, 80),
        last_message_at: now,
      })) as { id: string; title: string };
    }
    const conversationId = conversation.id;
    send({ type: 'conversation', id: conversationId, title: conversation.title });

    const earlier = await assistant.listAssistantMessages(
      { conversation_id: conversationId },
      { order: { created_at: 'DESC' }, take: HISTORY },
    );
    const history: ChatMessage[] = earlier
      .reverse()
      .filter((m) => m.content)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content:
          m.role === 'user' && m.attachments
            ? `${m.content}\n[${m.attachments} screenshot(s) were attached]`
            : m.content,
      }));
    await assistant.createAssistantMessages({
      conversation_id: conversationId,
      role: 'user',
      content: input.text,
      attachments: input.images.length,
    });

    const images: { url: string }[] = [];
    const result = await runTurn({
      key,
      model: settings.chat_model,
      access,
      tools: await allowedTools(access, TOOLS),
      history,
      userText: input.text,
      images: input.images,
      signal: ctl.signal,
      budgetUsd: Number(settings.daily_cap_usd) - spent,
      memory: await memoryFor(assistant, access.userId),
      now,
      emit: send,
      ctx: {
        container: scope,
        port: req.socket.localPort as number,
        openrouterKey: key,
        imageModel: settings.image_model,
        imageStyle: settings.image_style?.trim() || DEFAULT_IMAGE_STYLE,
        styleRefs: await styleRefs(settings.style_refs),
        attachments: input.images,
        showImage: async (image, name, mime) => {
          const type =
            mime ??
            MIME[(await sharp(image).metadata()).format ?? ''] ??
            'image/jpeg';
          const url = await storeImage(
            scope,
            image,
            `assistant-${Date.now()}-${name}`,
            type,
          );
          images.push({ url });
          send({ type: 'image', url });
          return url;
        },
      },
    });
    const saved = await assistant.createAssistantMessages({
      conversation_id: conversationId,
      role: 'assistant',
      content: result.text,
      // json columns: the arrays are stored as they are.
      images: (images.length ? images : null) as unknown as Record<
        string,
        unknown
      > | null,
      tools: (result.tools.length ? result.tools : null) as unknown as Record<
        string,
        unknown
      > | null,
      model: settings.chat_model,
      cost_usd: result.cost,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      error: result.error ?? null,
    });
    await assistant.updateAssistantConversations({
      id: conversationId,
      last_message_at: new Date(),
    });
    // One line per answer, so a failing key or model shows in the logs.
    logger.info(
      `[assistant] answer user=${access.userId} conv=${conversationId} model=${settings.chat_model} tools=${result.tools.map((t) => `${t.name}:${t.ok ? 'ok' : 'fail'}`).join(',') || '-'} cost=${result.cost.toFixed(4)} ms=${Date.now() - now.getTime()}${result.error ? ` error=${result.error}` : ''}`,
    );
    if (result.error && result.error !== 'aborted') {
      send({ type: 'error', message: result.error });
    }
    finish({ type: 'done', message_id: saved.id, cost_usd: result.cost });
  } catch (err) {
    logger.warn(
      `[assistant] turn failed user=${access.userId}: ${(err as Error)?.message}`,
    );
    finish({
      type: 'error',
      message: 'The assistant hit a problem. Try again in a moment.',
    });
  } finally {
    clearInterval(ping);
    busy.delete(access.userId);
  }
}
