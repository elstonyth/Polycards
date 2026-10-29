import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import { last4, openKey, sealKey } from '../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../modules/assistant/service';

// GET/POST /admin/assistant-settings (spec 2026-10-29): Settings → AI. The
// OpenRouter key is write-only — sealed on the way in, and only whether one
// is set (and readable) plus its last 4 characters ever come back. RBAC
// (assistant_setting:read/update, admin-rbac.ts) keeps it to super admins.

const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

const jwtSecret = (req: AuthenticatedMedusaRequest) =>
  req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig.http
    .jwtSecret as string;

async function view(req: AuthenticatedMedusaRequest) {
  const s = await req.scope
    .resolve<AssistantModuleService>(ASSISTANT_MODULE)
    .settings();
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
    daily_cap_usd: Number(s.daily_cap_usd),
    updated_by: s.updated_by,
    updated_at: s.updated_at,
  };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json({ settings: await view(req) });
}

type Body = {
  openrouter_key?: unknown;
  chat_model?: unknown;
  image_model?: unknown;
  daily_cap_usd?: unknown;
};

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
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
  for (const field of ['chat_model', 'image_model'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 100 || !MODEL_RE.test(v.trim())) {
      res.status(400).json({
        message: `${field} must be an OpenRouter model id like anthropic/claude-sonnet-5.5.`,
      });
      return;
    }
    patch[field] = v.trim();
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
