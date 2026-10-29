// The admin AI assistant's client side (spec 2026-10-29): the plain JSON
// routes, and the chat stream — one JSON event per line, read as it arrives.

declare const __BACKEND_URL__: string;

export type AssistantTool = { name: string; label: string };

export type AssistantMe = {
  super_admin: boolean;
  key_set: boolean;
  chat_model: string;
  tools: AssistantTool[];
  spent_today_usd: number;
  daily_cap_usd: number;
};

export type ToolRun = { name: string; args: unknown; ok: boolean; ms: number };

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments: number;
  images: { url: string }[];
  tools: ToolRun[];
  error: string | null;
  cost_usd: number;
  created_at: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  last_message_at: string;
};

export type AssistantSettings = {
  openrouter_key: { set: boolean; readable: boolean; last4: string | null };
  chat_model: string;
  image_model: string;
  /** Voice: the model that writes down speech, the one that reads aloud,
   *  and its voice. */
  stt_model: string;
  voice_model: string;
  voice: string;
  /** OpenRouter's speaking models and their voices; empty while the
   *  server can't get the list. */
  speech_models: { id: string; voices: string[] }[];
  /** OpenRouter's models each field can use (its dropdown); empty while the
   *  server can't get the list. */
  chat_models: string[];
  image_models: string[];
  stt_models: string[];
  daily_cap_usd: number;
  /** The house look for AI images; null = the default below. */
  image_style: string | null;
  image_style_default: string;
  /** Uploaded references; [] = the default ones below. */
  style_refs: string[];
  style_refs_default: { note: string; url: string }[];
  updated_by: string | null;
  updated_at: string;
};

export type ReviewRow = ConversationSummary & {
  user_id: string;
  questions: number;
  failed: number;
  cost_usd: number;
  /** Deleted from the chat list: still in this account's review. */
  deleted: boolean;
};

export type ChatEvent =
  | { type: 'conversation'; id: string; title: string }
  /** A spoken question as it was heard. */
  | { type: 'transcript'; text: string }
  | { type: 'text'; delta: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      label: string;
      status: 'start' | 'done' | 'error';
      ms?: number;
    }
  | { type: 'image'; url: string }
  /** A note or scheduled task the AI proposed: saved only when the asker
   *  taps Save (confirmProposal), so text planted in data can't save one. */
  | {
      type: 'confirm';
      kind: 'note' | 'schedule';
      summary: string;
      token: string;
    }
  | { type: 'error'; message: string; code?: string; reason?: string }
  | { type: 'done'; message_id: string; cost_usd: number }
  | { type: 'ping' };

/** An answer read aloud: its sample rate, base64 PCM16 mono chunks, then done. */
export type SpeechEvent =
  | { type: 'format'; rate: number }
  | { type: 'audio'; data: string }
  | { type: 'error'; message: string; code?: string; reason?: string }
  | { type: 'done'; cost_usd?: number }
  | { type: 'ping' };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = (await res.json().catch(() => null)) as
    (T & { message?: string; code?: string }) | null;
  if (!res.ok) {
    throw Object.assign(
      new Error(data?.message ?? `Request failed (${res.status}).`),
      { status: res.status, code: data?.code },
    );
  }
  return data as T;
}

/** Saves a proposed note or task (the chat's `confirm` event) with its token.
 *  A refusal throws with the server's `code`: confirm_expired or
 *  confirm_refused. */
export const confirmProposal = (token: string) =>
  call<{ kind: 'note' | 'schedule'; next_run_at: string | null }>(
    '/admin/assistant/confirm',
    { method: 'POST', body: JSON.stringify({ token }) },
  );

export const assistantApi = {
  me: () => call<AssistantMe>('/admin/assistant/me'),
  conversations: () =>
    call<{ conversations: ConversationSummary[] }>(
      '/admin/assistant/conversations',
    ),
  conversation: (id: string) =>
    call<{
      conversation: { id: string; title: string };
      messages: StoredMessage[];
    }>(`/admin/assistant/conversations/${encodeURIComponent(id)}`),
  remove: (id: string) =>
    call<{ deleted: boolean }>(
      `/admin/assistant/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  settings: () =>
    call<{ settings: AssistantSettings }>('/admin/assistant-settings'),
  saveSettings: (patch: {
    openrouter_key?: string | null;
    chat_model?: string;
    image_model?: string;
    stt_model?: string;
    voice_model?: string;
    voice?: string;
    daily_cap_usd?: number;
    image_style?: string | null;
    style_refs?: string[] | null;
  }) =>
    call<{ settings: AssistantSettings }>('/admin/assistant-settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  testKey: () =>
    call<
      | {
          ok: true;
          account: {
            label: string | null;
            usage: number;
            limit_remaining: number | null;
          };
        }
      | { ok: false; message: string }
    >('/admin/assistant-settings/test', { method: 'POST', body: '{}' }),
  reviewThread: (id: string) =>
    call<{
      conversation: { id: string; title: string; user_id: string };
      messages: StoredMessage[];
      /** Only the newest 500 messages came back. */
      truncated?: boolean;
    }>(`/admin/assistant-review/${encodeURIComponent(id)}`),
};

/** Splits streamed text into whole JSON lines; the unfinished tail is kept
 *  for the next chunk. Lines that are not JSON are skipped. */
export function takeEvents<E = ChatEvent>(
  buffer: string,
): {
  events: E[];
  rest: string;
} {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: E[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as E);
    } catch {
      // A broken line is dropped, never shown.
    }
  }
  return { events, rest };
}

/** Asks one question, typed (message) or spoken (audio: base64 WAV); every
 *  event is handed to onEvent as it arrives. */
export function streamChat(
  body: {
    conversation_id?: string;
    message?: string;
    images?: string[];
    audio?: string;
  },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamEvents('/admin/assistant/chat', body, onEvent, signal);
}

/** Reads one of the asker's answers aloud, chunk by chunk. */
export function streamSpeech(
  messageId: string,
  onEvent: (e: SpeechEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamEvents(
    '/admin/assistant/speak',
    { message_id: messageId },
    onEvent,
    signal,
  );
}

/** Speaks a short sample in a voice that may not be saved yet (Settings → AI). */
export function streamVoiceTest(
  body: { voice_model: string; voice: string; lang: 'en' | 'zh' },
  onEvent: (e: SpeechEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamEvents(
    '/admin/assistant-settings/voice-test',
    body,
    onEvent,
    signal,
  );
}

async function streamEvents<E>(
  path: string,
  body: object,
  onEvent: (
    e: E | { type: 'error'; message: string; code?: string; reason?: string },
  ) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as {
      message?: string;
      code?: string;
      reason?: string;
    } | null;
    // A refusal before streaming still carries its code, so it is translated.
    onEvent({
      type: 'error',
      message: data?.message ?? `Request failed (${res.status}).`,
      ...(data?.code ? { code: data.code } : {}),
      ...(data?.reason ? { reason: data.reason } : {}),
    });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { events, rest } = takeEvents<E>(done ? `${buffer}\n` : buffer);
    buffer = rest;
    events.forEach(onEvent);
    if (done) return;
  }
}

/** A pasted or dropped image as a data URL, shrunk to at most 1600px on the
 *  long side (JPEG) so a phone screenshot stays well under the 5 MB limit. */
export async function imageToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // JPEG has no alpha: transparent pixels would export black, not white.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.88);
}
