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
import {
  cutToolMarkup,
  generationCost,
  OpenRouterError,
  speechModels,
} from '../openrouter';
import { userLock } from '../user-lock';
import {
  estimateSpeechCost,
  speak,
  speakable,
  speechChoiceProblem,
  spokenLength,
} from '../voice';

// POST /admin/assistant/speak {message_id} (voice.ts): reads one of the
// asker's answers aloud, as newline-delimited JSON:
//   format {rate} · audio {data: base64 PCM16 mono} … ·
//   error {code,message,reason?} · done {cost_usd}
// What it cost is saved as a hidden voice row, so it counts toward today's
// cap whichever day the answer was written: a safe overestimate at once,
// then OpenRouter's own figure, which arrives some seconds after the
// reading. The speech is stored too, as a private file (the row's tools say
// which), so hearing it again with the same voice is free; deleting the chat
// deletes it.

type Body = { message_id?: unknown };
type SpeechCache = {
  message_id: string;
  voice_model: string;
  voice: string;
  file_id: string;
  rate?: number; // absent on readings stored before 2026-10-29: 24 kHz
};
// About 0.5 s of 24 kHz PCM16 per replayed audio event; even, so no
// sample is split.
const CHUNK = 24 * 1024;
// One read-aloud at a time per staff member (user-lock.ts), so parallel reads
// can't all pass the daily cap before any saves its cost. Longer than a
// reading can run (voice.ts: 3 minutes) plus its file save.
const speaking = userLock('speaking', 240_000);
// OpenRouter's figure for a reading is looked up this many times, 1.5 s
// apart: it showed up about 7 s after a reading ended (2026-10-29).
const COST_LOOKUPS = 12;
// The file store (Spaces) sets no timeout of its own: a stalled read or
// upload is given up after this, so the slot and the request move on.
const STORE_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer in ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
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
  const text = speakable(cutToolMarkup(message.content));
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
    const problem = await speechChoiceProblem(
      settings.voice_model,
      settings.voice,
    );
    if (problem) {
      finish({
        type: 'error',
        code: 'bad_voice_model',
        message: `The voice in Settings → AI assistant can't be used: ${problem} An admin must pick another.`,
        reason: problem,
      });
      return;
    }
    const files = scope.resolve<IFileModuleService>(Modules.FILE);
    // Its prices, for the estimate (kept from the check above).
    const listed = (await speechModels())?.get(settings.voice_model);

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
      const stored = await withTimeout(
        files.getAsBuffer(cached.file_id),
        STORE_MS,
      ).catch(() => null);
      if (!stored?.length) {
        logger.warn(
          `[assistant] stored speech unreadable, speaking again: ${id}`,
        );
        return false;
      }
      send({ type: 'format', rate: cached.rate ?? 24000 });
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
    let release = await speaking.take(access.userId);
    for (
      const until = Date.now() + SLOT_WAIT_MS;
      !release && Date.now() < until;
    ) {
      await new Promise((r) => setTimeout(r, 200));
      if (ctl.signal.aborted) {
        finish(); // the asker left while waiting
        return;
      }
      release = await speaking.take(access.userId);
    }
    if (!release) {
      finish({
        type: 'error',
        code: 'busy',
        message: 'Another answer is being read aloud. Wait for it to finish.',
      });
      return;
    }
    let cost = 0;
    let rate = 0;
    const generations: string[] = [];
    let sent = 0; // pieces asked for: each may be billed
    let failure: string | null = null;
    // OpenRouter answered no (an HTTP 4xx) before any audio: nothing billed
    let refused = false;
    // The voice row, saved with an overestimate before speaking, so the
    // cost counts even if this process dies mid-reading.
    let rowId: string | null = null;
    let saved: SpeechCache | null = null;
    const pcm: Buffer[] = [];
    let bytes = 0;
    // OpenRouter's own figure for the pieces read, in place of the estimate;
    // the estimate stays if any piece's figure can't be found.
    const settleCost = async (rowId: string, ids: string[]) => {
      try {
        const costs = await Promise.all(
          ids.map((g) => generationCost(key, g, undefined, COST_LOOKUPS)),
        );
        if (costs.some((c) => !c)) {
          logger.warn(
            `[assistant] reading cost not found, estimate kept: msg=${id}`,
          );
          return;
        }
        await assistant.updateAssistantMessages({
          id: rowId,
          cost_usd: costs.reduce((a, b) => a + b, 0),
        });
      } catch (err) {
        logger.warn(
          `[assistant] reading cost not updated: ${(err as Error)?.message}`,
        );
      }
    };
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
      if (ctl.signal.aborted) {
        finish(); // left before anything was asked of OpenRouter: no cost
        return;
      }
      rowId = (
        await assistant.createAssistantMessages({
          conversation_id: message.conversation_id,
          role: 'voice',
          content: '',
          model: settings.voice_model,
          cost_usd: estimateSpeechCost(
            listed,
            text.length,
            spokenLength(text) / 10,
          ),
          tokens_in: 0,
          tokens_out: 0,
          tools: null,
          error: null,
        })
      ).id;
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
            const chunk = Buffer.from(e.data, 'base64');
            pcm.push(chunk);
            bytes += chunk.length;
          } else if (e.type === 'format') {
            send(e);
            rate = e.rate;
          } else if (e.type === 'piece') sent++;
          else generations.push(e.id);
        }
      } catch (err) {
        // A timeout in speak() is a failure; only the asker leaving is not.
        if (!ctl.signal.aborted) {
          // one line in the log, whatever OpenRouter's text holds
          failure = String((err as Error)?.message || 'failed')
            .split(key)
            .join('[key]')
            .replace(/[\r\n]+/g, ' ');
          refused =
            err instanceof OpenRouterError &&
            (err.status ?? 0) >= 400 &&
            (err.status ?? 0) < 500;
        }
      }
      // Kept only when heard to the end: a cut-short clip is never replayed.
      if (!failure && !ctl.signal.aborted && pcm.length) {
        const file = await withTimeout(
          files.createFiles({
            filename: `assistant-voice-${id}.pcm`,
            mimeType: 'application/octet-stream',
            content: Buffer.concat(pcm).toString('base64'),
            access: 'private',
          }),
          STORE_MS,
        ).catch((err: Error) => {
          logger.warn(`[assistant] speech not stored: ${err?.message}`);
          return null;
        });
        if (file) {
          saved = {
            message_id: id,
            voice_model: settings.voice_model,
            voice: settings.voice,
            file_id: file.id,
            rate,
          };
        }
      }
    } finally {
      if (rowId) {
        // Speech returns no bill: the row keeps a safe overestimate, and
        // OpenRouter's own figure replaces it once every piece's is found.
        // The whole text, whatever was heard or what the headers said: a
        // piece asked for is charged whether heard or not. Only a reading
        // never sent, or refused (4xx) before any audio or generation, costs
        // nothing; a stop, a timeout or a dropped connection may still be
        // billed, so it is estimated too.
        const heardSeconds = rate ? bytes / 2 / rate : 0;
        cost =
          !sent || (refused && !generations.length && !bytes)
            ? 0
            : estimateSpeechCost(
                listed,
                text.length,
                Math.max(heardSeconds, spokenLength(text) / 10),
              );
        const kept = rowId;
        await assistant
          .updateAssistantMessages({
            id: kept,
            cost_usd: cost,
            tools: saved,
            error: failure,
          })
          .catch((err: Error) =>
            logger.warn(`[assistant] voice cost not saved: ${err?.message}`),
          );
        // The chat deleted while this read: its files went with it, so this
        // one must too.
        if (saved) {
          const [still] = await assistant
            .listAssistantConversations(
              { id: message.conversation_id },
              { take: 1 },
            )
            .catch(() => [true]);
          if (!still) {
            await files
              .deleteFiles([saved.file_id])
              .catch((err: Error) =>
                logger.warn(`[assistant] orphan speech kept: ${err?.message}`),
              );
          }
        }
        // Only when every piece asked for has an id: one cut short before its
        // headers may still be billed, so the estimate stays.
        if (sent && generations.length === sent)
          void settleCost(kept, generations);
      }
      await release();
    }
    logger.info(
      `[assistant] spoke user=${access.userId} msg=${id} model=${settings.voice_model} chars=${text.length} estimate=${cost.toFixed(4)}${failure ? ` error=${failure}` : ''}`,
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
