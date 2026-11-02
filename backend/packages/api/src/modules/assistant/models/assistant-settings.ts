import { model } from '@medusajs/framework/utils';

// assistant_settings — the in-admin AI assistant's singleton (owner,
// 2026-10-29: "in the setting tab I will add the AI API key"). The OpenRouter
// key is stored sealed (key-vault.ts) and never sent back: the settings route
// answers with last4 only.
export const AssistantSettings = model.define('assistant_settings', {
  id: model.id({ prefix: 'aiset' }).primaryKey(),
  openrouter_key_sealed: model.text().nullable(),
  openrouter_key_last4: model.text().nullable(),
  chat_model: model.text().default('anthropic/claude-sonnet-5.5'),
  image_model: model.text().default('google/gemini-3.1-flash-image'),
  // Per staff member, per Malaysia day, in USD (OpenRouter bills in USD).
  daily_cap_usd: model.float().default(20),
  // The house look for AI images; null = the default written from the
  // brand's posted posters (api/admin/assistant/brand-style.ts).
  image_style: model.text().nullable(),
  // Uploaded images of the brand's own posts the image model matches;
  // null = the bundled key art of the posted posters.
  style_refs: model.json().nullable(),
  // Voice (voice.ts): the model that writes down what staff say, the model
  // that reads answers aloud, and its voice.
  stt_model: model.text().default('google/gemini-3.5-flash-lite'),
  voice_model: model.text().default('google/gemini-3.8-flash-lite-tts'),
  voice: model.text().default('Kore'),
  // The admin user id of the last change.
  updated_by: model.text().nullable(),
});

export default AssistantSettings;
