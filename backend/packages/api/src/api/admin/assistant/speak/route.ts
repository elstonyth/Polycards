import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { openKey } from '../../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor } from '../access';
import { generationCost, MODEL_RE } from '../openrouter';
import { speak, speakable, VOICES } from '../voice';

// POST /admin/assistant/speak {message_id} (voice.ts): reads one of the
// asker's answers aloud, as newline-delimited JSON:
//   audio {data: base64 PCM16, 24 kHz mono} … · error {code,message} ·
//   done {cost_usd}
// What it cost is saved as a hidden voice row, so it counts toward today's
// cap whichever day the answer was written.

type Body = { message_id?: unknown };

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
      code: 'bad_model',
      message:
        'The voice in Settings → AI assistant is not allowed here. An admin must pick another.',
    });
    return;
  }
  const spent = await assistant.spentToday(access.userId);
  if (spent >= Number(settings.daily_cap_usd)) {
    finish({
      type: 'error',
      code: 'daily_cap',
      message: `You reached today's assistant limit (USD ${Number(settings.daily_cap_usd).toFixed(2)}). It resets at 00:00 Malaysia time.`,
    });
    return;
  }

  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER);
  let cost = 0;
  let priced = false;
  let generation = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let failure: string | null = null;
  try {
    for await (const e of speak({
      key,
      model: settings.voice_model,
      voice: settings.voice,
      text,
      signal: ctl.signal,
    })) {
      if (e.type === 'audio') send(e);
      else if (e.type === 'generation') generation = e.id;
      else {
        cost += e.cost;
        tokensIn += e.tokensIn;
        tokensOut += e.tokensOut;
        priced = true;
      }
    }
  } catch (err) {
    if (!ctl.signal.aborted) failure = (err as Error)?.message ?? 'failed';
  }
  // Stopped or failed before the bill arrived: OpenRouter still charges it.
  if (!priced && generation) cost += await generationCost(key, generation);
  await assistant
    .createAssistantMessages({
      conversation_id: message.conversation_id,
      role: 'voice',
      content: '',
      model: settings.voice_model,
      cost_usd: cost,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      error: failure,
    })
    .then(() =>
      // spentToday finds today's costs through last_message_at.
      assistant.updateAssistantConversations({
        id: message.conversation_id,
        last_message_at: new Date(),
      }),
    )
    .catch((err: Error) =>
      logger.warn(`[assistant] voice cost not saved: ${err?.message}`),
    );
  logger.info(
    `[assistant] spoke user=${access.userId} msg=${id} model=${settings.voice_model} chars=${text.length} cost=${cost.toFixed(4)}${failure ? ` error=${failure}` : ''}`,
  );
  if (failure) {
    finish({
      type: 'error',
      code: 'speak_failed',
      message: `Could not read it aloud: ${failure}`,
    });
    return;
  }
  finish({ type: 'done', cost_usd: cost });
}
