import { openRouterUrl, OpenRouterError } from './openrouter';

// Voice (owner, 2026-10-29: "able to answer and reply, listening"). Both
// halves go through OpenRouter's chat completions, the only voice API it has:
//  - transcribe(): the admin records the question as 16 kHz WAV; a listening
//    model writes down what was said (input_audio), and that text is asked.
//  - speak(): a voice model reads an answer aloud, streamed as raw PCM16
//    (24 kHz mono) chunks the admin plays as they arrive.
// Models and voice are set in Settings → AI assistant; costs count toward
// the daily cap (transcribing on the answer, speaking on a voice row).

export const VOICES = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
] as const;
// About 75 s of 16 kHz mono 16-bit WAV.
export const MAX_AUDIO_BYTES = 2.5 * 1024 * 1024;
// Longer answers are cut at a sentence and the rest stays on screen.
const MAX_SPOKEN_CHARS = 1500;

const LISTEN_PROMPT =
  'You write down speech. Return exactly what the speaker said, in the language they spoke (English, Malay, Chinese or a mix), with punctuation. Do not translate, answer, summarise or comment. If nothing was said, return an empty reply. ' +
  // House words the listening model would otherwise misspell.
  'The speaker works at Polycards, a trading card shop. Spell these as written: Polycards, PSA, BGS, CGC, TNG, Maybank, Pokémon, One Piece, Pikachu, Charizard, slab, pack, vault, buyback, top-up, RM, sen. Write spoken numbers and amounts as digits (RM 1,250.50, 3 packs).';
const SPEAK_PROMPT =
  "You are a voice. Read the user's text aloud exactly as written, naturally and warmly, in the text's own language. Say numbers and money the way people say them. Do not add, answer, comment or ask anything.";

/** One more try, about 600 ms later, when OpenRouter could not be reached
 *  or was busy (network error, 429, 5xx). Never after a stop or a timeout,
 *  and only before any audio is sent. */
async function retryOnce(
  call: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const first = await call();
    if (first.status !== 429 && first.status < 500) return first;
    await first.body?.cancel().catch(() => undefined);
  } catch (err) {
    const name = (err as Error)?.name;
    if (signal?.aborted || name === 'AbortError' || name === 'TimeoutError') {
      throw err;
    }
  }
  await new Promise((r) => setTimeout(r, 600));
  signal?.throwIfAborted();
  return call();
}

/** What was said in a WAV recording, and what writing it down cost. */
export async function transcribe(opts: {
  key: string;
  model: string;
  wavBase64: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; cost: number }> {
  const answer = await retryOnce(
    () =>
      (opts.fetchImpl ?? fetch)(openRouterUrl(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.key}`,
          'content-type': 'application/json',
          'x-title': 'Polycards admin assistant',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: LISTEN_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: { data: opts.wavBase64, format: 'wav' },
                },
              ],
            },
          ],
          temperature: 0,
          usage: { include: true },
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(45_000),
          ...(opts.signal ? [opts.signal] : []),
        ]),
      }),
    opts.signal,
  );
  const body = (await answer.json().catch(() => null)) as {
    error?: { message?: string };
    usage?: { cost?: number };
    choices?: { message?: { content?: string | null } }[];
  } | null;
  if (!answer.ok || !body?.choices) {
    throw new OpenRouterError(
      body?.error?.message ?? `OpenRouter answered ${answer.status}.`,
      answer.status,
    );
  }
  return {
    text: String(body.choices[0]?.message?.content ?? '').trim(),
    cost: Number(body.usage?.cost ?? 0),
  };
}

/** Markdown as it should be heard: no symbols, tables read row by row,
 *  links by their words, long answers cut at a sentence. */
export function speakable(markdown: string): string {
  const lines: string[] = [];
  let header: string[] | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^\|?\s*:?-{2,}/.test(line)) continue; // table rule
    if (line.startsWith('|')) {
      const cells = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      if (!header) {
        header = cells;
        continue;
      }
      lines.push(
        cells
          // An empty or dash-only cell says nothing: skip it, not "Amount —".
          .map((c, i) =>
            /^[\s*_~—–-]*$/.test(c)
              ? ''
              : header?.[i] && i > 0
                ? `${header[i]} ${c}`
                : c,
          )
          .filter(Boolean)
          .join(', ') + '.',
      );
      continue;
    }
    header = null;
    lines.push(line);
  }
  let text = lines
    .join('\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    // Dashes and arrows between words are a pause, not a symbol to read.
    .replace(/\s*[—→]+\s*|\s+–\s+/g, ', ')
    .replace(/~~/g, '') // strikethrough; one ~ is "about" and stays
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length > MAX_SPOKEN_CHARS) {
    const cut = text.slice(0, MAX_SPOKEN_CHARS);
    const end = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('。'),
      cut.lastIndexOf('\n'),
    );
    text = `${cut.slice(0, end > 200 ? end + 1 : MAX_SPOKEN_CHARS)} The rest is on screen.`;
  }
  return text;
}

export type SpeechEvent =
  | { type: 'audio'; data: string }
  | { type: 'usage'; cost: number; tokensIn: number; tokensOut: number }
  | { type: 'generation'; id: string };

/** Reads `text` aloud: base64 PCM16 (24 kHz mono) chunks as they arrive,
 *  then what it cost. */
export async function* speak(opts: {
  key: string;
  model: string;
  voice: string;
  text: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<SpeechEvent> {
  const answer = await retryOnce(
    () =>
      (opts.fetchImpl ?? fetch)(openRouterUrl(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.key}`,
          'content-type': 'application/json',
          'x-title': 'Polycards admin assistant',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: SPEAK_PROMPT },
            { role: 'user', content: opts.text },
          ],
          modalities: ['text', 'audio'],
          audio: { voice: opts.voice, format: 'pcm16' },
          stream: true,
          usage: { include: true },
        }),
        signal: opts.signal,
      }),
    opts.signal,
  );
  if (!answer.ok || !answer.body) {
    const body = (await answer.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new OpenRouterError(
      body?.error?.message ?? `OpenRouter answered ${answer.status}.`,
      answer.status,
    );
  }
  const decoder = new TextDecoder();
  const reader = answer.body.getReader();
  let buffer = '';
  let generation = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: {
        id?: string;
        error?: { message?: string; code?: number };
        usage?: {
          cost?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        };
        choices?: { delta?: { audio?: { data?: string } } }[];
      };
      try {
        chunk = JSON.parse(data);
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
      const audio = chunk.choices?.[0]?.delta?.audio?.data;
      if (audio) yield { type: 'audio', data: audio };
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
}
