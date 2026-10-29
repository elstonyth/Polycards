import type { Access } from './access';
import {
  OpenRouterError,
  streamChat,
  type ChatContent,
  type ChatMessage,
} from './openrouter';
import { systemPrompt } from './prompt';
import { toolSpecs, type AssistantTool, type ToolCtx } from './tools';

// One question in, one answer out (spec 2026-10-29): the model may call tools
// for up to MAX_ROUNDS rounds; the last round is offered no tools, so it has
// to answer with what it has. Only tools in `tools` (the asker's) can run:
// a call to any other name is answered "no access", never executed.

export const MAX_ROUNDS = 8;

export type TurnEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      label: string;
      status: 'start' | 'done' | 'error';
      ms?: number;
    };

export type ToolRecord = {
  name: string;
  args: unknown;
  ok: boolean;
  ms: number;
};

export type TurnResult = {
  text: string;
  tools: ToolRecord[];
  cost: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
};

export async function runTurn(opts: {
  key: string;
  model: string;
  access: Access;
  tools: AssistantTool[];
  history: ChatMessage[];
  userText: string;
  images: string[];
  ctx: Omit<ToolCtx, 'addCost' | 'signal' | 'access'>;
  emit: (e: TurnEvent) => void;
  signal: AbortSignal;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<TurnResult> {
  const result: TurnResult = {
    text: '',
    tools: [],
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const ctx: ToolCtx = {
    ...opts.ctx,
    access: opts.access,
    signal: opts.signal,
    addCost: (usd) => {
      result.cost += usd;
    },
  };
  const userContent: ChatContent = opts.images.length
    ? [
        { type: 'text', text: opts.userText },
        ...opts.images.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
      ]
    : opts.userText;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt(opts.access, [...byName.keys()], opts.now),
    },
    ...opts.history,
    { role: 'user', content: userContent },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1;
      let roundText = '';
      let calls: { id: string; name: string; arguments: string }[] = [];
      for await (const ev of streamChat({
        key: opts.key,
        model: opts.model,
        messages,
        tools: last ? [] : toolSpecs(opts.tools),
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
      })) {
        if (ev.type === 'text') {
          roundText += ev.delta;
          result.text += ev.delta;
          opts.emit(ev);
        } else if (ev.type === 'usage') {
          result.cost += ev.cost;
          result.tokensIn += ev.tokensIn;
          result.tokensOut += ev.tokensOut;
        } else {
          calls = ev.calls;
        }
      }
      if (!calls.length) return result;
      if (roundText && !roundText.endsWith('\n')) {
        // Text before a tool call ("Let me check...") stays its own paragraph.
        result.text += '\n\n';
        opts.emit({ type: 'text', delta: '\n\n' });
      }
      messages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      });
      for (const call of calls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await runTool(call, byName, ctx, opts.emit, result),
        });
      }
    }
    return result;
  } catch (err) {
    result.error = opts.signal.aborted
      ? 'aborted'
      : err instanceof OpenRouterError
        ? err.message
        : `The assistant stopped: ${(err as Error)?.message ?? String(err)}`;
    return result;
  }
}

async function runTool(
  call: { id: string; name: string; arguments: string },
  byName: Map<string, AssistantTool>,
  ctx: ToolCtx,
  emit: (e: TurnEvent) => void,
  result: TurnResult,
): Promise<string> {
  const tool = byName.get(call.name);
  if (!tool) {
    result.tools.push({ name: call.name, args: null, ok: false, ms: 0 });
    return `No access: the asker's admin role does not include ${call.name}. Tell them plainly; do not estimate.`;
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    args =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return 'Error: the tool arguments were not valid JSON. Call it again with a JSON object.';
  }
  const started = Date.now();
  emit({
    type: 'tool',
    id: call.id,
    name: tool.name,
    label: tool.label,
    status: 'start',
  });
  try {
    const out = await tool.run(args, ctx);
    const ms = Date.now() - started;
    result.tools.push({ name: tool.name, args, ok: true, ms });
    emit({
      type: 'tool',
      id: call.id,
      name: tool.name,
      label: tool.label,
      status: 'done',
      ms,
    });
    return out;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const ms = Date.now() - started;
    result.tools.push({ name: tool.name, args, ok: false, ms });
    emit({
      type: 'tool',
      id: call.id,
      name: tool.name,
      label: tool.label,
      status: 'error',
      ms,
    });
    return `Error: ${(err as Error)?.message ?? String(err)}`;
  }
}
