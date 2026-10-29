import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { openKey } from '../../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor } from '../../assistant/access';
import { generationCost } from '../../assistant/openrouter';
import { speak, speechChoiceProblem } from '../../assistant/voice';

// POST /admin/assistant-settings/voice-test {voice_model?, voice?, lang?}:
// Settings → AI's "Hear it". Speaks a fixed sample in the given (unsaved)
// voice, or the saved one, as newline-delimited JSON like /assistant/speak:
//   format {rate} · audio {data: base64 PCM16 mono} … ·
//   error {code,message,reason?} · done
// Its cost is logged once OpenRouter has it, not saved: a one-sentence
// sample is a fraction of a cent, only super admins (who set the cap) can
// run it, it is rate limited, and there is no conversation to hang a voice
// row on.

const SAMPLES = {
  en: "Hi, I'm the Polycards assistant. Today we sold 128 packs.",
  zh: '你好，我是 Polycards 助手。今天我们卖出了 128 包卡。',
};

type Body = { voice_model?: unknown; voice?: unknown; lang?: unknown };

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const access = accessFor(req.scope, req.auth_context);
  if (!access.superAdmin) {
    res.status(403).json({ message: 'Only super admins test the voice.' });
    return;
  }
  const scope = req.scope;
  const settings = await scope
    .resolve<AssistantModuleService>(ASSISTANT_MODULE)
    .settings();
  const body = req.body ?? {};
  const model = body.voice_model ?? settings.voice_model;
  const voice = body.voice ?? settings.voice;
  const problem = await speechChoiceProblem(
    typeof model === 'string' ? model.trim() : model,
    voice,
  );
  if (problem || typeof model !== 'string') {
    res.status(400).json({ code: 'bad_voice_model', message: problem });
    return;
  }
  const key = settings.openrouter_key_sealed
    ? openKey(
        settings.openrouter_key_sealed,
        scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig
          .http.jwtSecret as string,
      )
    : null;
  if (!key) {
    res.status(400).json({ message: 'No readable key is saved.' });
    return;
  }

  // Stop in the browser closes the request: stop OpenRouter too.
  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctl.abort();
  });
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  const generations: string[] = [];
  let heard = false;
  let failure: string | null = null;
  try {
    for await (const e of speak({
      key,
      model: model.trim(),
      voice: voice as string,
      text: body.lang === 'zh' ? SAMPLES.zh : SAMPLES.en,
      signal: ctl.signal,
    })) {
      if (e.type === 'generation') generations.push(e.id);
      else if (e.type !== 'piece') {
        send(e);
        if (e.type === 'audio') heard = true;
      }
    }
  } catch (err) {
    // Only Stop is quiet: a timeout inside speak() is a failure. One line in
    // the log, whatever OpenRouter's text holds.
    if (!ctl.signal.aborted) {
      failure = String((err as Error)?.message || 'failed')
        .split(key)
        .join('[key]')
        .replace(/[\r\n]+/g, ' ');
    }
  }
  // Speech returns no bill: OpenRouter's figure arrives some seconds after,
  // so it is logged then, after the answer has gone.
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER);
  void Promise.all(
    generations.map((g) => generationCost(key, g, undefined, 12)),
  )
    .then((costs) =>
      logger.info(
        `[assistant] voice test user=${access.userId} model=${model.trim()} voice=${voice} cost=${costs.reduce((a, b) => a + b, 0).toFixed(4)}${failure ? ` error=${failure}` : ''}`,
      ),
    )
    .catch(() => undefined);
  send(
    failure
      ? {
          type: 'error',
          code: 'speak_failed',
          message: `Could not play the sample: ${failure}`,
          reason: failure,
        }
      : !heard
        ? {
            type: 'error',
            code: 'no_audio',
            message:
              'The voice model sent no sound. Pick another speaking model.',
          }
        : { type: 'done' },
  );
  if (!res.writableEnded) res.end();
}
