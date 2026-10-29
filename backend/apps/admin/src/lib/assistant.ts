// The admin AI assistant's client side (spec 2026-10-29): the plain JSON
// routes, and the chat stream — one JSON event per line, read as it arrives.

declare const __BACKEND_URL__: string;

export type AssistantTool = { name: string; label: string };

export type AssistantMe = {
  super_admin: boolean;
  key_set: boolean;
  chat_model: string;
  tools: AssistantTool[];
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
  daily_cap_usd: number;
  updated_by: string | null;
  updated_at: string;
};

export type ReviewRow = ConversationSummary & {
  user_id: string;
  user_email: string | null;
  questions: number;
  failed: number;
  cost_usd: number;
};

export type ChatEvent =
  | { type: 'conversation'; id: string; title: string }
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
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; message_id: string; cost_usd: number }
  | { type: 'ping' };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${__BACKEND_URL__}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { message?: string })
    | null;
  if (!res.ok) {
    throw Object.assign(
      new Error(data?.message ?? `Request failed (${res.status}).`),
      { status: res.status },
    );
  }
  return data as T;
}

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
    daily_cap_usd?: number;
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
  review: (offset = 0) =>
    call<{ count: number; conversations: ReviewRow[] }>(
      `/admin/assistant-review?limit=50&offset=${offset}`,
    ),
  reviewThread: (id: string) =>
    call<{
      conversation: { id: string; title: string; user_id: string };
      messages: StoredMessage[];
    }>(`/admin/assistant-review/${encodeURIComponent(id)}`),
};

/** Splits streamed text into whole JSON lines; the unfinished tail is kept
 *  for the next chunk. Lines that are not JSON are skipped. */
export function takeEvents(buffer: string): {
  events: ChatEvent[];
  rest: string;
} {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: ChatEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {
      // A broken line is dropped, never shown.
    }
  }
  return { events, rest };
}

/** Asks one question; every event is handed to onEvent as it arrives. */
export async function streamChat(
  body: { conversation_id?: string; message: string; images?: string[] },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${__BACKEND_URL__}/admin/assistant/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    onEvent({
      type: 'error',
      message: data?.message ?? `Request failed (${res.status}).`,
    });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { events, rest } = takeEvents(done ? `${buffer}\n` : buffer);
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
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.88);
}
