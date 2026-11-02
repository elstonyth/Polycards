import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import { last4, openKey, sealKey } from '../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../modules/assistant/service';
import { accessFor } from '../assistant/access';
import { isOwnOrigin } from '../assistant/agent-tools';
import { DEFAULT_IMAGE_STYLE } from '../assistant/brand-style';
import { DEFAULT_STYLE_REFS } from '../assistant/style-refs';
import { MODEL_RE, modelCatalog, speechModels } from '../assistant/openrouter';
import { DEFAULT_VOICE_MODEL, speechChoiceProblem } from '../assistant/voice';

// GET/POST /admin/assistant-settings (spec 2026-10-29): Settings → AI. The
// OpenRouter key is write-only — sealed on the way in, and only whether one
// is set (and readable) plus its last 4 characters ever come back. Super
// admins only: checked in each handler, because RBAC's assistant_setting:read
// also passes `*:read` (the desk bots).

const jwtSecret = (req: AuthenticatedMedusaRequest) =>
  req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig.http
    .jwtSecret as string;

async function view(req: AuthenticatedMedusaRequest) {
  const s = await req.scope
    .resolve<AssistantModuleService>(ASSISTANT_MODULE)
    .settings();
  const [speech, models] = await Promise.all([speechModels(), modelCatalog()]);
  return {
    openrouter_key: {
      set: !!s.openrouter_key_sealed,
      // false = stored, but the server secret it was sealed under changed.
      readable: s.openrouter_key_sealed
        ? openKey(s.openrouter_key_sealed, jwtSecret(req)) !== null
        : false,
      last4: s.openrouter_key_last4,
    },
    chat_model: s.chat_model,
    image_model: s.image_model,
    // Voice (voice.ts): the listening model, the speaking model, its voice.
    stt_model: s.stt_model,
    voice_model: s.voice_model,
    voice: s.voice,
    // OpenRouter's models each field can use, for its dropdown; empty while
    // the list can't be had (the fields still take a typed id).
    chat_models: models?.chat ?? [],
    image_models: models?.image ?? [],
    stt_models: models?.listen ?? [],
    // OpenRouter's speaking models and their voices; empty while the list
    // can't be had (the page then takes a typed model id and voice).
    speech_models: [...(speech ?? new Map()).entries()]
      .map(([id, m]) => ({ id, voices: m.voices ?? [] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    daily_cap_usd: Number(s.daily_cap_usd),
    // The house look for AI images: what is saved (null = the default), and
    // the default itself so the page can show and restore it.
    image_style: s.image_style,
    image_style_default: DEFAULT_IMAGE_STYLE,
    style_refs: Array.isArray(s.style_refs) ? (s.style_refs as string[]) : [],
    style_refs_default: DEFAULT_STYLE_REFS.map((r) => ({
      note: r.note,
      url: r.url,
    })),
    updated_by: s.updated_by,
    updated_at: s.updated_at,
  };
}

const MAX_STYLE = 4000;
const MAX_REFS = 6;

/** A reference image URL: an upload of ours (our sites, file store, or the
 *  local file provider in dev). The image engine fetches it. */
const refUrlOk = (u: unknown): u is string =>
  typeof u === 'string' && u.length <= 500 && isOwnOrigin(u);

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!accessFor(req.scope, req.auth_context).superAdmin) {
    res.status(403).json({ message: 'Only super admins see AI settings.' });
    return;
  }
  res.json({ settings: await view(req) });
}

type Body = {
  openrouter_key?: unknown;
  chat_model?: unknown;
  image_model?: unknown;
  stt_model?: unknown;
  voice_model?: unknown;
  voice?: unknown;
  daily_cap_usd?: unknown;
  image_style?: unknown;
  style_refs?: unknown;
};

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  if (!accessFor(req.scope, req.auth_context).superAdmin) {
    res.status(403).json({ message: 'Only super admins change AI settings.' });
    return;
  }
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (body.openrouter_key === null) {
    patch.openrouter_key_sealed = null;
    patch.openrouter_key_last4 = null;
  } else if (body.openrouter_key !== undefined) {
    const key =
      typeof body.openrouter_key === 'string' ? body.openrouter_key.trim() : '';
    if (key.length < 20 || key.length > 300 || /\s/.test(key)) {
      res.status(400).json({ message: 'That does not look like an API key.' });
      return;
    }
    patch.openrouter_key_sealed = sealKey(key, jwtSecret(req));
    patch.openrouter_key_last4 = last4(key);
  }
  // Each with an example of its own kind of model.
  for (const [field, example] of [
    ['chat_model', 'anthropic/claude-sonnet-5.5'],
    ['image_model', 'google/gemini-3.1-flash-image'],
    ['stt_model', 'google/gemini-3.5-flash-lite'],
    ['voice_model', DEFAULT_VOICE_MODEL],
  ] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 100 || !MODEL_RE.test(v.trim())) {
      res.status(400).json({
        message: `${field} must be an OpenRouter model id like ${example}.`,
      });
      return;
    }
    patch[field] = v.trim();
  }
  // The speaking model and its voice go together: a voice belongs to one
  // model, so either one changing checks the pair.
  if (body.voice_model !== undefined || body.voice !== undefined) {
    const saved = await req.scope
      .resolve<AssistantModuleService>(ASSISTANT_MODULE)
      .settings();
    const problem = await speechChoiceProblem(
      patch.voice_model ?? saved.voice_model,
      body.voice === undefined ? saved.voice : body.voice,
    );
    if (problem) {
      res.status(400).json({ message: problem });
      return;
    }
    if (body.voice !== undefined) patch.voice = body.voice;
  }
  // The house look: text, or null / empty to go back to the default.
  if (body.image_style !== undefined) {
    const v = body.image_style;
    if (v !== null && (typeof v !== 'string' || v.length > MAX_STYLE)) {
      res.status(400).json({
        message: `image_style must be text of at most ${MAX_STYLE} characters.`,
      });
      return;
    }
    patch.image_style = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  // Reference images: up to 6 of our own uploads, or [] / null = default.
  if (body.style_refs !== undefined) {
    const v = body.style_refs;
    if (
      v !== null &&
      (!Array.isArray(v) || v.length > MAX_REFS || !v.every(refUrlOk))
    ) {
      res.status(400).json({
        message: `style_refs must be at most ${MAX_REFS} uploaded image URLs.`,
      });
      return;
    }
    patch.style_refs = Array.isArray(v) && v.length ? v : null;
  }
  if (body.daily_cap_usd !== undefined) {
    // A real number from 0.5 to 1000: an empty field (null, '') must never
    // save as 0, which would stop every staff member's assistant.
    const raw = body.daily_cap_usd;
    const cap =
      typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
        ? Number(raw)
        : NaN;
    if (!Number.isFinite(cap) || cap < 0.5 || cap > 1000) {
      res
        .status(400)
        .json({ message: 'daily_cap_usd must be between 0.5 and 1000.' });
      return;
    }
    patch.daily_cap_usd = cap;
  }
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const current = await assistant.settings();
  await assistant.updateAssistantSettings({
    id: current.id,
    ...patch,
    updated_by: req.auth_context.actor_id,
  });
  req.scope
    .resolve(ContainerRegistrationKeys.LOGGER)
    .info(
      `[assistant] settings changed by ${req.auth_context.actor_id}: ${Object.keys(patch).join(', ') || 'nothing'}`,
    );
  res.json({ settings: await view(req) });
}
