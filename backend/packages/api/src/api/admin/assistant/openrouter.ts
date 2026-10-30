import { setTimeout as sleep } from 'node:timers/promises';

// OpenRouter's chat completions (OpenAI-compatible), streamed (spec
// 2026-10-29). Tests point ASSISTANT_OPENROUTER_BASE at a local fake;
// nothing else does.

const base = (): string =>
  (
    process.env.ASSISTANT_OPENROUTER_BASE || 'https://openrouter.ai/api/v1'
  ).replace(/\/+$/, '');

// A model id as Settings → AI assistant takes it: no suffix, or one that
// changes only price or speed. `:online` would let the model fetch the web,
// an outside channel; so would a model with search built in (Perplexity's,
// the *-search-* ones), so those are refused too.
export const MODEL_RE =
  /^(?!perplexity\/)(?![^:]*search)[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::(?:free|nitro|floor|extended|thinking|beta))?$/i;

export const openRouterUrl = (): string => `${base()}/chat/completions`;
export const speechUrl = (): string => `${base()}/audio/speech`;

/** A speaking model as OpenRouter lists it: its voices (null when it lists
 *  none) and its prices in USD — per input token or character (prompt) and
 *  per output audio token or second (completion). */
export type SpeechModel = {
  voices: string[] | null;
  prompt: number;
  completion: number;
};
let speechList: {
  until: number;
  models: Map<string, SpeechModel> | null;
} | null = null;

/** OpenRouter's speaking models (a public list), kept an hour. When a fetch
 *  fails, or the list comes back empty, the last good list (or null) stands
 *  in and the fetch is tried again a minute later. null while none has been
 *  had: callers then check only the model id's form. */
export async function speechModels(
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, SpeechModel> | null> {
  if (speechList && Date.now() < speechList.until) return speechList.models;
  let models: Map<string, SpeechModel> | null = null;
  try {
    const answer = await fetchImpl(
      `${base()}/models?output_modalities=speech`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!answer.ok) await answer.body?.cancel().catch(() => undefined);
    const body = answer.ok
      ? ((await answer.json()) as {
          data?: {
            id?: string;
            supported_voices?: unknown;
            pricing?: { prompt?: string; completion?: string };
          }[];
        } | null)
      : null;
    if (Array.isArray(body?.data) && body.data.length) {
      models = new Map(
        body.data
          .filter((m) => typeof m.id === 'string' && m.id.trim() !== '')
          .map((m) => {
            // an empty name would break the Settings picker (a select item
            // can't have an empty value): never listed
            const voices = Array.isArray(m.supported_voices)
              ? m.supported_voices.filter(
                  (v): v is string => typeof v === 'string' && v.trim() !== '',
                )
              : [];
            return [
              m.id as string,
              {
                voices: voices.length ? voices : null,
                prompt: Number(m.pricing?.prompt ?? 0) || 0,
                completion: Number(m.pricing?.completion ?? 0) || 0,
              },
            ] as const;
          }),
      );
    }
  } catch {
    // OpenRouter unreachable: the last good list, if any, stands in
  }
  speechList = models
    ? { until: Date.now() + 3_600_000, models }
    : { until: Date.now() + 60_000, models: speechList?.models ?? null };
  return speechList.models;
}

/** Tests only: drop the kept list. */
export function forgetSpeechModels(): void {
  speechList = null;
}

/** The model ids Settings → AI assistant offers in its dropdowns, by what
 *  each setting needs: chat (answers and calls tools), image (draws), listen
 *  (takes audio, writes text). Only ids MODEL_RE takes (no web search). */
export type ModelCatalog = {
  chat: string[];
  image: string[];
  listen: string[];
};
type Listed = {
  id?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
};
let catalog: { until: number; value: ModelCatalog | null } | null = null;

const has = (list: unknown, item: string) =>
  Array.isArray(list) && list.includes(item);
const idsOf = (rows: Listed[], keep: (m: Listed) => boolean): string[] =>
  [
    ...new Set(
      rows
        .filter(keep)
        .map((m) => m.id)
        .filter(
          (id): id is string => typeof id === 'string' && MODEL_RE.test(id),
        ),
    ),
  ].sort();

/** OpenRouter's models (a public list), kept an hour; after a failure the
 *  last good catalog (or null) stands in and it is tried again a minute
 *  later. */
export async function modelCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog | null> {
  if (catalog && Date.now() < catalog.until) return catalog.value;
  const list = async (query: string): Promise<Listed[] | null> => {
    const answer = await fetchImpl(`${base()}/models${query}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!answer.ok) {
      await answer.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await answer.json()) as { data?: unknown } | null;
    return Array.isArray(body?.data) ? (body.data as Listed[]) : null;
  };
  let value: ModelCatalog | null = null;
  try {
    const [text, image] = await Promise.all([
      list(''),
      list('?output_modalities=image').catch(() => null),
    ]);
    if (text?.length) {
      const out = (m: Listed, kind: string) =>
        has(m.architecture?.output_modalities, kind);
      value = {
        chat: idsOf(
          text,
          (m) => has(m.supported_parameters, 'tools') && out(m, 'text'),
        ),
        image: idsOf(image ?? text, (m) => out(m, 'image')),
        listen: idsOf(
          text,
          (m) =>
            has(m.architecture?.input_modalities, 'audio') && out(m, 'text'),
        ),
      };
    }
  } catch {
    // OpenRouter unreachable: the last good catalog, if any, stands in
  }
  catalog = value
    ? { until: Date.now() + 3_600_000, value }
    : { until: Date.now() + 60_000, value: catalog?.value ?? null };
  return catalog.value;
}

/** Tests only: drop the kept catalog. */
export function forgetModelCatalog(): void {
  catalog = null;
}

/** The key's own account: its label, credit used and credit left. */
export async function keyInfo(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  label: string | null;
  usage: number;
  limit_remaining: number | null;
}> {
  const answer = await fetchImpl(`${base()}/key`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await answer.json().catch(() => null)) as {
    error?: { message?: string };
    data?: { label?: string; usage?: number; limit_remaining?: number | null };
  } | null;
  if (!answer.ok || !body?.data) {
    throw new OpenRouterError(
      body?.error?.message ?? `OpenRouter answered ${answer.status}.`,
      answer.status,
    );
  }
  return {
    label: body.data.label ?? null,
    usage: Number(body.data.usage ?? 0),
    limit_remaining: body.data.limit_remaining ?? null,
  };
}

/** What one generation cost, USD. OpenRouter bills a stream cut off before
 *  its usage chunk, so a stopped round is priced here. Best effort: 0 when
 *  unknown, never throws. */
export async function generationCost(
  key: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
  // a spoken reading shows up about 7 s after it ends (measured 2026-10-29)
  attempts = 2,
): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // The generation can 404 for a moment after the stream stops.
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    try {
      const answer = await fetchImpl(
        `${base()}/generation?id=${encodeURIComponent(id)}`,
        {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!answer.ok) {
        // not found yet: free the connection before trying again
        await answer.body?.cancel().catch(() => undefined);
        continue;
      }
      const body = (await answer.json()) as {
        data?: { total_cost?: number };
      } | null;
      return Math.max(0, Number(body?.data?.total_cost ?? 0) || 0);
    } catch {
      // Network error or timeout: try once more, then give up.
    }
  }
  return 0;
}

export type ChatContent =
  | string
  | (
      | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
      | { type: 'image_url'; image_url: { url: string } }
    )[];

/** The system prompt, cacheable on Anthropic models: their cache covers the
 *  tools and system text up to a cache_control mark, so the mark ends the
 *  text before "Now:", the first line that changes between questions. Only
 *  anthropic/* models get marks here (streamChat adds a second, top-level
 *  one). OpenAI, DeepSeek, Grok and Groq cache by themselves and Gemini 2.5+
 *  implicitly; Gemini's explicit cache and Qwen's (Alibaba) need marks too,
 *  which this does not send. */
export function systemContent(model: string, text: string): ChatContent {
  const cut = text.indexOf('\nNow: ') + 1;
  if (!/^anthropic\//i.test(model) || !cut) return text;
  return [
    {
      type: 'text',
      text: text.slice(0, cut),
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: text.slice(cut) },
  ];
}

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: 'system' | 'user'; content: ChatContent }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolSpec = {
  type: 'function';
  function: { name: string; description: string; parameters: object };
};

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'usage'; cost: number; tokensIn: number; tokensOut: number }
  /** The generation's id, sent once, so a cut-off round can be priced. */
  | { type: 'generation'; id: string };

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Chunk = {
  id?: string;
  error?: { message?: string; code?: number };
  usage?: {
    cost?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
};

const BUSY = new Set([429, 502, 503, 504]);

// DeepSeek's special tokens start like this. Barred from calling a tool (the
// last round), it writes the calls it still wants as text: <｜DSML｜ invoke ...>.
// That is never an answer, and the rest of what it says is more of the same.
// shortcut: DeepSeek's prefix only; add another model's when one is seen leaking.
const TOOL_MARKUP = '<｜';

export const cutToolMarkup = (text: string): string => {
  const at = text.indexOf(TOOL_MARKUP);
  return at < 0 ? text : text.slice(0, at);
};

/** Streams one completion: text as it comes (up to any leaked tool markup),
 *  then the tool calls it asked for (if any), then what it cost. */
export async function* streamChat(opts: {
  key: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<StreamEvent> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.key}`,
      'content-type': 'application/json',
      'x-title': 'Polycards admin assistant',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(opts.tools.length
        ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' }
        : {}),
      // Anthropic's automatic breakpoint on the last block, so a tool loop's
      // growing history is cached too (2 marks with the system one).
      ...(/^anthropic\//i.test(opts.model)
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
      stream: true,
      usage: { include: true },
    }),
    signal: opts.signal,
  };
  // One retry when OpenRouter is busy or out of reach: only before anything
  // streamed (a started answer is billed) and never once the turn stopped.
  let answer!: Response;
  for (let attempt = 0; attempt < 2; attempt++) {
    let wait = 800;
    try {
      answer = await (opts.fetchImpl ?? fetch)(openRouterUrl(), init);
      if (attempt || !BUSY.has(answer.status)) break;
      const after = Number(answer.headers.get('retry-after') ?? NaN);
      if (after >= 0) wait = Math.min(after * 1000, 3000);
      void answer.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (attempt || opts.signal?.aborted) throw err;
    }
    // The signal's own reason, so a round timeout stays a TimeoutError.
    await sleep(wait, undefined, { signal: opts.signal }).catch(() => {
      throw opts.signal?.reason;
    });
  }
  if (!answer.ok || !answer.body) {
    const body = (await answer.json().catch(() => null)) as Chunk | null;
    throw new OpenRouterError(
      body?.error?.message ?? `OpenRouter answered ${answer.status}.`,
      answer.status,
    );
  }

  const calls: { id: string; name: string; arguments: string }[] = [];
  // Which call a provider's index now points at, once a reused index has
  // moved on to a new call.
  const slot = new Map<number, number>();
  let generation = '';
  // A trailing '<' waits for the next piece: it may start TOOL_MARKUP.
  let held = '';
  let leaked = false;
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = answer.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      // Blank lines end SSE events; `:` lines are OpenRouter keep-alives.
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new OpenRouterError(
          chunk.error.message ?? 'OpenRouter stopped with an error.',
          chunk.error.code,
        );
      }
      if (chunk.id && !generation) {
        generation = chunk.id;
        yield { type: 'generation', id: chunk.id };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content && !leaked) {
        const text = held + delta.content;
        const clean = cutToolMarkup(text);
        leaked = clean !== text;
        held = !leaked && clean.endsWith('<') ? '<' : '';
        const out = held ? clean.slice(0, -1) : clean;
        if (out) yield { type: 'text', delta: out };
      }
      for (const tc of delta?.tool_calls ?? []) {
        // A new id starts a new call even when a provider reuses index 0,
        // and later pieces at that index follow it; a fragment with no
        // index and no id continues the last call.
        let i =
          tc.index === undefined
            ? Math.max(calls.length - 1, 0)
            : (slot.get(tc.index) ?? tc.index);
        if (tc.id && calls[i]?.id && calls[i].id !== tc.id) {
          i = calls.length;
          if (tc.index !== undefined) slot.set(tc.index, i);
        }
        calls[i] ??= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        // Some providers repeat the name in every piece, others split it.
        const name = tc.function?.name;
        if (name && calls[i].name !== name) calls[i].name += name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
      if (chunk.usage) {
        yield {
          type: 'usage',
          cost: Math.max(0, Number(chunk.usage.cost ?? 0) || 0),
          tokensIn: Number(chunk.usage.prompt_tokens ?? 0),
          tokensOut: Number(chunk.usage.completion_tokens ?? 0),
        };
      }
    }
    if (done) break;
  }
  if (held) yield { type: 'text', delta: held };
  const asked = calls.filter((c) => c && c.name);
  if (asked.length) {
    yield {
      type: 'tool_calls',
      calls: asked.map((c, i) => ({ ...c, id: c.id || `call_${i}` })),
    };
  }
}
