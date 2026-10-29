// OpenRouter's chat completions (OpenAI-compatible), streamed (spec
// 2026-10-29). Tests point ASSISTANT_OPENROUTER_BASE at a local fake;
// nothing else does.

const base = (): string =>
  (
    process.env.ASSISTANT_OPENROUTER_BASE || 'https://openrouter.ai/api/v1'
  ).replace(/\/+$/, '');

export const openRouterUrl = (): string => `${base()}/chat/completions`;

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

export type ChatContent =
  | string
  | (
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    )[];

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
  | { type: 'usage'; cost: number; tokensIn: number; tokensOut: number };

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Chunk = {
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

/** Streams one completion: text as it comes, then the tool calls it asked
 *  for (if any), then what it cost. */
export async function* streamChat(opts: {
  key: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<StreamEvent> {
  const answer = await (opts.fetchImpl ?? fetch)(openRouterUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.key}`,
      'content-type': 'application/json',
      'x-title': 'Polycards admin assistant',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(opts.tools.length ? { tools: opts.tools } : {}),
      stream: true,
      usage: { include: true },
    }),
    signal: opts.signal,
  });
  if (!answer.ok || !answer.body) {
    const body = (await answer.json().catch(() => null)) as Chunk | null;
    throw new OpenRouterError(
      body?.error?.message ?? `OpenRouter answered ${answer.status}.`,
      answer.status,
    );
  }

  const calls: { id: string; name: string; arguments: string }[] = [];
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
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) yield { type: 'text', delta: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
      if (chunk.usage) {
        yield {
          type: 'usage',
          cost: Number(chunk.usage.cost ?? 0),
          tokensIn: Number(chunk.usage.prompt_tokens ?? 0),
          tokensOut: Number(chunk.usage.completion_tokens ?? 0),
        };
      }
    }
    if (done) break;
  }
  const asked = calls.filter((c) => c && c.name);
  if (asked.length) {
    yield {
      type: 'tool_calls',
      calls: asked.map((c, i) => ({ ...c, id: c.id || `call_${i}` })),
    };
  }
}
