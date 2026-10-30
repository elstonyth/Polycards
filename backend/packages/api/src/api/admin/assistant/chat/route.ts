import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import sharp from 'sharp';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { openKey } from '../../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor, allowedTools, LASTING_WRITES } from '../access';
import { runTurn } from '../engine';
import { storeImage } from '../images';
import { DEFAULT_IMAGE_STYLE, styleRefs } from '../brand-style';
import { memoryFor } from '../agent-tools';
import { sealProposal } from '../confirm';
import {
  cutToolMarkup,
  generationCost,
  MODEL_RE,
  type ChatMessage,
} from '../openrouter';
import { SCHEDULED_PREFIX } from '../schedule';
import { TOOLS } from '../tools';
import { MAX_AUDIO_BYTES, transcribe } from '../voice';
import { userLock } from '../user-lock';

// POST /admin/assistant/chat (spec 2026-10-29): one question, answered as a
// stream of newline-delimited JSON events, so staff watch the answer and the
// tool steps arrive:
//   conversation {id,title} · text {delta} · tool {id,name,label,status,ms}
//   image {url} · error {message} · done {message_id,cost_usd} · ping
//   transcript {text} — a spoken question (body.audio) as it was heard
//   confirm {kind,summary,token} — a note or task to save with a tap (confirm.ts)
// The headers go out at once and a ping every 10 s keeps proxies from
// timing the request out while a poster or a query runs. Read-only: the only
// rows written are the conversation and its messages.

const MAX_TEXT = 4000;
const MAX_IMAGES = 4;
// The admin shrinks a screenshot to 1600px JPEG (well under 1 MB) before it
// sends it; the body limit (middlewares.ts) is sized to 4 of these.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const HISTORY = 20;
// One turn at a time per staff member (user-lock.ts). Longer than an answer
// can run (engine.ts: 4 minutes), so a crashed instance's lock frees itself.
const BUSY_MS = 360_000;
const busy = userLock('busy', BUSY_MS);

const IMAGE_RE = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const AUDIO_RE = /^[A-Za-z0-9+/]+={0,2}$/;

type Body = {
  conversation_id?: unknown;
  message?: unknown;
  images?: unknown;
  /** A spoken question: base64 16 kHz WAV (voice.ts). */
  audio?: unknown;
  /** A typed follow-up in Talk mode: its answer is read aloud too. */
  spoken?: unknown;
};

function parse(body: Body): {
  conversationId?: string;
  text: string;
  images: string[];
  audio?: string;
  spoken: boolean;
} {
  let audio: string | undefined;
  if (body.audio !== undefined && body.audio !== null) {
    if (typeof body.audio !== 'string' || !AUDIO_RE.test(body.audio)) {
      throw new Error('The recording must be a base64 WAV.');
    }
    if ((body.audio.length * 3) / 4 > MAX_AUDIO_BYTES) {
      throw new Error('A recording is at most about 75 seconds.');
    }
    // The byte cap is a duration cap only at the format the admin records:
    // 16 kHz mono 16-bit PCM, fmt chunk right after the RIFF header.
    const h = Buffer.from(body.audio.slice(0, 60), 'base64');
    if (
      h.length < 44 ||
      h.toString('latin1', 0, 4) !== 'RIFF' ||
      h.toString('latin1', 8, 16) !== 'WAVEfmt ' ||
      h.readUInt16LE(20) !== 1 ||
      h.readUInt16LE(22) !== 1 ||
      h.readUInt32LE(24) !== 16000 ||
      h.readUInt16LE(34) !== 16
    ) {
      throw new Error('The recording must be 16 kHz mono 16-bit WAV.');
    }
    audio = body.audio;
  }
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text && !audio) throw new Error('Type a question.');
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
  return {
    conversationId: id || undefined,
    text,
    images: images as string[],
    audio,
    spoken: audio !== undefined || body.spoken === true,
  };
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
        ? 'The AI key can no longer be read (the server secret changed). An admin must enter it again in Settings → AI assistant.'
        : 'The assistant has no AI key yet. An admin adds the OpenRouter key in Settings → AI assistant.',
    });
    return;
  }
  // A model saved before the :online check existed must not run.
  if (!MODEL_RE.test(String(settings.chat_model ?? ''))) {
    finish({
      type: 'error',
      code: 'bad_model',
      message:
        'The chat model in Settings → AI assistant is not allowed here (web-search models are off). An admin must pick another.',
    });
    return;
  }
  const release = await busy.take(access.userId);
  if (!release) {
    finish({
      type: 'error',
      code: 'busy',
      message:
        'Your previous question is still being answered. Wait for it, then ask again.',
    });
    return;
  }
  const ping = setInterval(() => send({ type: 'ping' }), 10_000);
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER);
  // What writing down a spoken question cost, and whether a row holds it
  // yet (its own or the answer's), so it is counted once and never lost.
  let listened = 0;
  let charged = false;
  // Listening is paid even when no answer follows: a hidden voice row counts
  // it toward the daily cap. A new chat made only to hold it is hidden at once.
  const chargeListening = async (
    title: string,
    cost = listened,
    model = settings.stt_model,
  ) => {
    const at = new Date();
    // Bumped first: spentToday finds today's rows by last_message_at. A chat
    // deleted meanwhile can't be bumped, so the cost goes to a hidden one.
    let heldIn = conversation;
    if (heldIn) {
      const held = heldIn;
      heldIn = await assistant
        .updateAssistantConversations({ id: held.id, last_message_at: at })
        .then(() => held)
        .catch(() => undefined);
    }
    const hidden = !heldIn;
    heldIn ??= (await assistant.createAssistantConversations({
      user_id: access.userId,
      title,
      last_message_at: at,
    })) as { id: string; title: string };
    await assistant.createAssistantMessages({
      conversation_id: heldIn.id,
      role: 'voice',
      content: '',
      // Not a read-aloud row (speak/route.ts): the review counts it as cost only.
      tools: { kind: 'listen' },
      model,
      cost_usd: cost,
    });
    charged = true;
    if (hidden) {
      await assistant.softDeleteAssistantConversations([heldIn.id]);
    }
  };
  // What the answer cost once it ran, until its row is saved: a failure
  // after the turn must not lose it.
  let unsaved = 0;

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

    // A spoken question is written down first, then asked like a typed one.
    if (input.audio) {
      if (!MODEL_RE.test(String(settings.stt_model ?? ''))) {
        finish({
          type: 'error',
          code: 'bad_stt_model',
          message:
            'The listening model in Settings → AI assistant is not allowed here. An admin must pick another.',
        });
        return;
      }
      // Gone already: start nothing that would be paid for.
      if (ctl.signal.aborted) {
        finish();
        return;
      }
      let heard: { text: string; cost: number };
      try {
        // No abort signal: a cut-off request is still billed, and only a
        // finished one says what it cost. transcribe() stops itself at 45 s.
        heard = await transcribe({
          key,
          model: settings.stt_model,
          wavBase64: input.audio,
        });
      } catch (err) {
        // shortcut: a refused request is not charged by OpenRouter; a
        // TimeoutError may be, but no usage came back to count.
        const reason = (err as Error).message;
        logger.warn(
          `[assistant] listen failed user=${access.userId} model=${settings.stt_model}: ${reason}`,
        );
        finish({
          type: 'error',
          code: 'listen_failed',
          reason,
          message: `Could not listen to that recording: ${reason}`,
        });
        return;
      }
      listened = heard.cost;
      // The asker left while it was written down: keep its cost, ask nothing.
      if (ctl.signal.aborted) {
        if (listened > 0)
          await chargeListening('(voice) left before the answer');
        finish();
        return;
      }
      input.text = heard.text.slice(0, MAX_TEXT);
      send({ type: 'transcript', text: input.text });
      if (!input.text) {
        if (listened > 0) await chargeListening('(voice) nothing heard');
        finish({
          type: 'error',
          code: 'no_speech',
          message: "I didn't catch that. Try again.",
        });
        return;
      }
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
    send({
      type: 'conversation',
      id: conversationId,
      title: conversation.title,
    });

    const earlier = await assistant.listAssistantMessages(
      { conversation_id: conversationId, role: ['user', 'assistant'] },
      { order: { created_at: 'DESC' }, take: HISTORY },
    );
    const history: ChatMessage[] = earlier
      .reverse()
      // A saved answer with leaked tool calls would teach the model to repeat them.
      .map((m) => ({ ...m, content: cutToolMarkup(m.content) }))
      .filter((m) => m.content.trim())
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
    // spentToday finds today's costs by last_message_at: an old chat must
    // count from the start of this answer.
    await assistant.updateAssistantConversations({
      id: conversationId,
      last_message_at: now,
    });

    const images: { url: string; file_id: string }[] = [];
    const result = await runTurn({
      key,
      model: settings.chat_model,
      access,
      tools: (await allowedTools(access, TOOLS)).filter(
        (t) =>
          !(
            input.text.startsWith(SCHEDULED_PREFIX) &&
            LASTING_WRITES.has(t.name)
          ),
      ),
      history,
      userText: input.text,
      images: input.images,
      spoken: input.spoken,
      signal: ctl.signal,
      budgetUsd: Number(settings.daily_cap_usd) - spent - listened,
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
        // A note or task the person saves with a tap (confirm.ts); a
        // scheduled run has nobody to tap, and no such tools.
        propose: (proposal, summary) =>
          send({
            type: 'confirm',
            kind: proposal.kind,
            summary,
            token: sealProposal(
              proposal,
              access.userId,
              http.jwtSecret as string,
            ),
          }),
        showImage: async (image, name, mime) => {
          const type =
            mime ??
            MIME[(await sharp(image).metadata()).format ?? ''] ??
            'image/jpeg';
          const { id: fileId, url } = await storeImage(
            scope,
            image,
            `assistant-${Date.now()}-${name}`,
            type,
          );
          images.push({ url, file_id: fileId });
          send({ type: 'image', url });
          return url;
        },
      },
    });
    // Writing down a spoken question is paid for with its answer.
    result.cost += listened;
    unsaved = result.cost;
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
    charged = true;
    // Rounds cut off before their bill are in at an estimate: OpenRouter's
    // own figure replaces it once every one has shown up (it can take ~7 s).
    if (result.pending.length) {
      const rowId = saved.id;
      const charged = result.cost;
      const pending = result.pending;
      void (async () => {
        try {
          const found = await Promise.all(
            pending.map((p) => generationCost(key, p.id, undefined, 12)),
          );
          if (found.some((c) => !c)) return; // the estimate stays
          const estimated = pending.reduce((sum, p) => sum + p.estimate, 0);
          const actual = found.reduce((sum, c) => sum + c, 0);
          await assistant.updateAssistantMessages({
            id: rowId,
            cost_usd: Math.max(0, charged - estimated + actual),
          });
        } catch (err) {
          logger.warn(
            `[assistant] answer cost not updated: ${(err as Error)?.message}`,
          );
        }
      })();
    }
    // The chat may have been deleted in another tab meanwhile: the answer
    // is saved, so still finish with done.
    await assistant
      .updateAssistantConversations({
        id: conversationId,
        last_message_at: new Date(),
      })
      .catch((err: Error) =>
        logger.warn(
          `[assistant] conversation update failed conv=${conversationId}: ${err?.message}`,
        ),
      );
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
    // What was already paid for (the recording, and the answer if it ran)
    // still counts toward the cap.
    const lost = Math.max(unsaved, listened);
    if (lost > 0 && !charged) {
      await chargeListening(
        '(voice) answer failed',
        lost,
        unsaved > 0 ? settings.chat_model : settings.stt_model,
      ).catch((e: Error) =>
        logger.warn(
          `[assistant] cost not saved user=${access.userId} cost=${lost}: ${e?.message}`,
        ),
      );
    }
    finish({
      type: 'error',
      message: 'The assistant hit a problem. Try again in a moment.',
    });
  } finally {
    clearInterval(ping);
    await release();
  }
}
