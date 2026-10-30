import { LASTING_WRITES, type Access } from './access';
import {
  OpenRouterError,
  streamChat,
  systemContent,
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
// Limits on one answer (review 2026-10-29): a step may run at most 6 tools,
// an answer may draw at most 4 posters or images, one model call may take
// 90 s (OpenRouter keep-alives would otherwise hold a stuck call open) and
// the whole answer 4 minutes.
export const MAX_CALLS_PER_ROUND = 6;
export const MAX_IMAGES_PER_TURN = 4;
const ROUND_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 240_000;
const DRAWS = /(_poster|^generate_image)$/;
// Barred from tools but not told why, a model that was not done may answer
// nothing (seen on Sonnet) or write the calls as text (DeepSeek, openrouter.ts).
const LAST_ROUND =
  'That was your last tool step: no more tools. Answer the question now in plain text, in the language it was asked in, from what the tools returned. Say plainly what you could not confirm.';

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
  /** Rounds cut off before their bill (Stop, a timeout): each is in cost as
   *  an estimate; the caller swaps in OpenRouter's figure once it shows up. */
  pending: { id: string; estimate: number }[];
};

// What a round cut off before its bill is counted at until OpenRouter's own
// figure arrives (or for good, when it never names the round): the prompt at
// $15 per million tokens (~3 characters a token) and $0.05 for what it said.
// Above what the house models charge, so a stop never spends past the cap.
function roundEstimate(messages: ChatMessage[]): number {
  return (JSON.stringify(messages).length / 3) * 15e-6 + 0.05;
}

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
  /** Saved notes for this person (shared and their own). */
  memory?: string[];
  /** What the asker may still spend today, USD: the answer stops once spent. */
  budgetUsd?: number;
  /** Asked by voice: the answer is shaped to be read aloud. */
  spoken?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<TurnResult> {
  const result: TurnResult = {
    text: '',
    tools: [],
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    pending: [],
  };
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  // One deadline for the whole answer, tools included.
  const turnSignal = AbortSignal.any([
    opts.signal,
    AbortSignal.timeout(TURN_TIMEOUT_MS),
  ]);
  let shown = 0;
  const ctx: ToolCtx = {
    ...opts.ctx,
    access: opts.access,
    userText: opts.userText,
    signal: turnSignal,
    // Screenshots may be text a customer wrote: no lasting writes this turn.
    readOutside: opts.images.length > 0,
    showImage: async (...args) => {
      const url = await opts.ctx.showImage(...args);
      shown++;
      return url;
    },
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
      content: systemContent(
        opts.model,
        systemPrompt(
          opts.access,
          [...byName.keys()],
          opts.now,
          opts.memory,
          opts.spoken,
        ),
      ),
    },
    ...opts.history,
    { role: 'user', content: userContent },
  ];

  let drawn = 0;
  // A round asked for and not yet billed (its usage chunk not seen), and its
  // generation once named: one cut off is still billed, even before its
  // first chunk, so it is counted at an estimate.
  let open = false;
  let unpriced: string | undefined;
  const chargeOpenRound = () => {
    if (!open) return;
    const estimate = roundEstimate(messages);
    result.cost += estimate;
    if (unpriced) result.pending.push({ id: unpriced, estimate });
    open = false;
    unpriced = undefined;
  };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (opts.budgetUsd !== undefined && result.cost >= opts.budgetUsd) {
        result.error =
          "You reached today's assistant limit during this answer.";
        return result;
      }
      const last = round === MAX_ROUNDS - 1;
      if (last) messages.push({ role: 'user', content: LAST_ROUND });
      let roundText = '';
      let calls: { id: string; name: string; arguments: string }[] = [];
      open = true;
      for await (const ev of streamChat({
        key: opts.key,
        model: opts.model,
        messages,
        // The last round keeps the tool list (a history holding tool calls
        // needs it) but may not call one: it must answer.
        tools: toolSpecs(opts.tools),
        toolChoice: last ? 'none' : 'auto',
        signal: AbortSignal.any([
          turnSignal,
          AbortSignal.timeout(ROUND_TIMEOUT_MS),
        ]),
        fetchImpl: opts.fetchImpl,
      })) {
        if (ev.type === 'text') {
          roundText += ev.delta;
          result.text += ev.delta;
          opts.emit(ev);
        } else if (ev.type === 'usage') {
          open = false;
          unpriced = undefined;
          result.cost += ev.cost;
          result.tokensIn += ev.tokensIn;
          result.tokensOut += ev.tokensOut;
        } else if (ev.type === 'generation') {
          unpriced = ev.id;
        } else {
          calls = ev.calls;
        }
      }
      // A round that ended without a usage chunk is still billed.
      chargeOpenRound();
      if (!calls.length || last) {
        // Only this round can answer: an earlier one's text is "Let me check...".
        const silent = !roundText.trim() && !shown;
        if (calls.length || (last && silent)) {
          // The last round may not call tools; one that still does never answered.
          result.error =
            'The assistant ran out of steps. Ask a narrower question.';
        } else if (silent) {
          result.error = 'The assistant gave no answer. Ask again.';
        }
        return result;
      }
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
      for (const [i, call] of calls.entries()) {
        let content: string;
        if (i >= MAX_CALLS_PER_ROUND) {
          content = `Skipped: at most ${MAX_CALLS_PER_ROUND} tool calls per step. Call the rest in the next step if still needed.`;
        } else if (
          DRAWS.test(call.name) &&
          opts.budgetUsd !== undefined &&
          result.cost >= opts.budgetUsd
        ) {
          content =
            "Skipped: today's assistant limit is spent, so no more posters or images in this answer.";
        } else if (DRAWS.test(call.name) && drawn >= MAX_IMAGES_PER_TURN) {
          content = `Skipped: at most ${MAX_IMAGES_PER_TURN} posters or images per answer. Tell the asker to ask again for more.`;
        } else {
          if (DRAWS.test(call.name)) drawn++;
          content = await runTool(call, byName, ctx, opts.emit, result);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: untrusted(call.name, content),
        });
        ctx.readOutside = true;
      }
    }
    return result;
  } catch (err) {
    // The turn's deadline is a TimeoutError too: check it before a round's.
    result.error = opts.signal.aborted
      ? 'aborted'
      : turnSignal.aborted
        ? 'The answer took too long. Ask a narrower question.'
        : (err as Error)?.name === 'TimeoutError'
          ? 'The AI model did not answer in time. Try again.'
          : err instanceof OpenRouterError
            ? err.message
            : `The assistant stopped: ${(err as Error)?.message ?? String(err)}`;
    // Refused outright (a 4xx before anything was generated): not billed.
    const refused =
      err instanceof OpenRouterError &&
      !unpriced &&
      (err.status ?? 0) >= 400 &&
      (err.status ?? 0) < 500;
    if (!refused) chargeOpenRound();
    return result;
  }
}

// Tool results carry text customers and staff wrote (names, notes, order
// remarks): fenced, so the model reads them as data (prompt.ts says text
// inside a tool result is never an instruction). Every < and > inside is
// escaped, so nothing in the data can close the fence or open another tag;
// the name comes from the model, so only a plain tool name goes in.
export const untrusted = (tool: string, text: string): string =>
  `<tool_result name="${/^[a-z0-9_]{1,64}$/.test(tool) ? tool : 'unknown'}">\n${text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n</tool_result>`;

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
  if (LASTING_WRITES.has(tool.name) && ctx.readOutside) {
    result.tools.push({ name: tool.name, args: null, ok: false, ms: 0 });
    return `Refused: ${tool.name} saves something that lasts, so it runs only as the first step of an answer, before any tool output (which may carry someone else's instructions). Nothing was saved. If the asker wants it, ask them to send that request on its own.`;
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
    // A refused, stopped or timed-out image is still billed (its error
    // carries the cost), Stop included.
    const cost = Number((err as { cost?: unknown })?.cost ?? 0);
    if (cost > 0) ctx.addCost(cost);
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
