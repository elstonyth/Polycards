import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import type { IFileModuleService } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { openKey } from '../../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor } from '../access';
import { generationCost, MODEL_RE } from '../openrouter';
import { speak, speakable, VOICES } from '../voice';

// POST /admin/assistant/speak {message_id} (voice.ts): reads one of the
// asker's answers aloud, as newline-delimited JSON:
//   audio {data: base64 PCM16, 24 kHz mono} … · error {code,message,reason?} ·
//   done {cost_usd}
// What it cost is saved as a hidden voice row, so it counts toward today's
// cap whichever day the answer was written. The speech is stored too, as a
// private file (the row's tools say which), so hearing it again with the same
// voice is free; deleting the chat deletes it.

type Body = { message_id?: unknown };
type SpeechCache = {
  message_id: string;
  voice_model: string;
  voice: string;
  file_id: string;
};
// About 0.5 s of 24 kHz PCM16 per replayed audio event; even, so no
// sample is split.
const CHUNK = 24 * 1024;
// One read-aloud at a time per staff member, so parallel reads can't all
// pass the daily cap before any saves its cost.
// shortcut: per process, so each of the 2 web instances has its own; move to
// the chat route's Redis lock if staff start racing across instances.
const speaking = new Set<string>();
const SLOT_WAIT_MS = 10_000;

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const id = req.body?.message_id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ message: 'message_id is required.' });
    return;
  }
  const scope = req.scope;
  const assistant = scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const access = accessFor(scope, req.auth_context);
  const [message] = await assistant.listAssistantMessages(
    { id, role: 'assistant' },
    { take: 1 },
  );
  const [own] = message
    ? await assistant.listAssistantConversations(
        { id: message.conversation_id, user_id: access.userId },
        { take: 1 },
      )
    : [];
  if (!message || !own) {
    res.status(404).json({ message: 'That answer was not found.' });
    return;
  }
  const text = speakable(message.content);
  if (!text) {
    res.status(400).json({ message: 'That answer has nothing to read aloud.' });
    return;
  }

  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctl.abort();
  });
  const settings = await assistant.settings();
  const { http } = scope.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  const key = settings.openrouter_key_sealed
    ? openKey(settings.openrouter_key_sealed, http.jwtSecret as string)
    : null;
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER);

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

  // Headers are out: anything that throws from here ends the stream with an
  // error event instead of hanging it.
  try {
    if (!key) {
      finish({
        type: 'error',
        code: 'no_key',
        message:
          'The assistant has no readable AI key. An admin adds it in Settings → AI assistant.',
      });
      return;
    }
    if (
      !MODEL_RE.test(String(settings.voice_model ?? '')) ||
      !(VOICES as readonly string[]).includes(settings.voice)
    ) {
      finish({
        type: 'error',
        code: 'bad_voice_model',
        message:
          'The voice in Settings → AI assistant is not allowed here. An admin must pick another.',
      });
      return;
    }
    const files = scope.resolve<IFileModuleService>(Modules.FILE);

    // Read before with this voice: play the stored speech, free. Only this
    // conversation's voice rows, which the check above proved are the asker's.
    const replayed = async (): Promise<boolean> => {
      const voiceRows = await assistant.listAssistantMessages(
        { conversation_id: message.conversation_id, role: 'voice' },
        { select: ['tools'], order: { created_at: 'DESC' } },
      );
      const cached = voiceRows
        .map((r) => r.tools as unknown as Partial<SpeechCache> | null)
        .find(
          (t): t is SpeechCache =>
            t?.message_id === id &&
            t.voice_model === settings.voice_model &&
            t.voice === settings.voice &&
            typeof t.file_id === 'string',
        );
      if (!cached) return false;
      const stored = await files.getAsBuffer(cached.file_id).catch(() => null);
      if (!stored?.length) {
        logger.warn(
          `[assistant] stored speech unreadable, speaking again: ${id}`,
        );
        return false;
      }
      for (let at = 0; at < stored.length && !ctl.signal.aborted; at += CHUNK) {
        send({
          type: 'audio',
          data: stored.subarray(at, at + CHUNK).toString('base64'),
        });
      }
      logger.info(
        `[assistant] spoke user=${access.userId} msg=${id} model=${settings.voice_model} cached`,
      );
      finish({ type: 'done', cost_usd: 0 });
      return true;
    };
    if (await replayed()) return;

    // A reading just stopped may still be saving its cost (the client stops
    // one and starts the next at once): wait for its slot a little.
    for (
      let waited = 0;
      speaking.has(access.userId) && waited < SLOT_WAIT_MS;
      waited += 200
    ) {
      await new Promise((r) => setTimeout(r, 200));
      if (ctl.signal.aborted) {
        finish(); // the asker left while waiting
        return;
      }
    }
    if (speaking.has(access.userId)) {
      finish({
        type: 'error',
        code: 'busy',
        message: 'Another answer is being read aloud. Wait for it to finish.',
      });
      return;
    }
    speaking.add(access.userId);
    let cost = 0;
    let priced = false;
    let generation = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let failure: string | null = null;
    let spoke = false;
    let saved: SpeechCache | null = null;
    const pcm: Buffer[] = [];
    try {
      // The reading we waited for may have stored this very answer.
      if (await replayed()) return;
      // Checked while holding the slot, so parallel reads can't all pass it.
      const spent = await assistant.spentToday(access.userId);
      if (spent >= Number(settings.daily_cap_usd)) {
        finish({
          type: 'error',
          code: 'daily_cap',
          message: `You reached today's assistant limit (USD ${Number(settings.daily_cap_usd).toFixed(2)}). It resets at 00:00 Malaysia time.`,
        });
        return;
      }
      // spentToday finds today's costs through last_message_at. Bumped before
      // speaking: a chat deleted mid-read can't be bumped, and its cost must
      // still count today.
      await assistant.updateAssistantConversations({
        id: message.conversation_id,
        last_message_at: new Date(),
      });
      spoke = true;
      try {
        for await (const e of speak({
          key,
          model: settings.voice_model,
          voice: settings.voice,
          text,
          signal: ctl.signal,
        })) {
          if (e.type === 'audio') {
            send(e);
            pcm.push(Buffer.from(e.data, 'base64'));
          } else if (e.type === 'generation') generation = e.id;
          else {
            cost += e.cost;
            tokensIn += e.tokensIn;
            tokensOut += e.tokensOut;
            priced = true;
          }
        }
      } catch (err) {
        // A timeout in speak() is a failure; only the asker leaving is not.
        if (!ctl.signal.aborted) {
          failure = String((err as Error)?.message || 'failed')
            .split(key)
            .join('[key]');
        }
      }
      // Kept only when heard to the end (the bill comes last): a cut-short clip
      // is never replayed.
      if (!failure && !ctl.signal.aborted && priced && pcm.length) {
        const file = await files
          .createFiles({
            filename: `assistant-voice-${id}.pcm`,
            mimeType: 'application/octet-stream',
            content: Buffer.concat(pcm).toString('base64'),
            access: 'private',
          })
          .catch((err: Error) => {
            logger.warn(`[assistant] speech not stored: ${err?.message}`);
            return null;
          });
        if (file) {
          saved = {
            message_id: id,
            voice_model: settings.voice_model,
            voice: settings.voice,
            file_id: file.id,
          };
        }
      }
    } finally {
      if (spoke) {
        // Stopped or failed before the bill arrived: OpenRouter still charges it.
        if (!priced && generation)
          cost += await generationCost(key, generation);
        await assistant
          .createAssistantMessages({
            conversation_id: message.conversation_id,
            role: 'voice',
            content: '',
            model: settings.voice_model,
            cost_usd: cost,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            tools: saved,
            error: failure,
          })
          .catch((err: Error) =>
            logger.warn(`[assistant] voice cost not saved: ${err?.message}`),
          );
      }
      speaking.delete(access.userId);
    }
    logger.info(
      `[assistant] spoke user=${access.userId} msg=${id} model=${settings.voice_model} chars=${text.length} cost=${cost.toFixed(4)}${failure ? ` error=${failure}` : ''}`,
    );
    if (failure) {
      finish({
        type: 'error',
        code: 'speak_failed',
        message: `Could not read it aloud: ${failure}`,
        reason: failure,
      });
      return;
    }
    if (!pcm.length && !ctl.signal.aborted) {
      finish({
        type: 'error',
        code: 'no_audio',
        message: 'The voice model sent no audio.',
      });
      return;
    }
    finish({ type: 'done', cost_usd: cost });
  } catch (err) {
    logger.error(
      `[assistant] speak failed msg=${id}: ${(err as Error)?.message}`,
    );
    finish({
      type: 'error',
      code: 'speak_failed',
      message: 'Could not read it aloud.',
    });
  }
}
