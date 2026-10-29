import { openRouterUrl, OpenRouterError } from './openrouter';

// Voice (owner, 2026-10-29: "able to answer and reply, listening"). Both
// halves go through OpenRouter's chat completions (it also has dedicated
// /audio/speech and /audio/transcriptions endpoints, not used here):
//  - transcribe(): the admin records the question as 16 kHz WAV; a listening
//    model writes down what was said (input_audio), and that text is asked.
//  - speak(): a voice model reads an answer aloud, streamed as raw PCM16
//    (24 kHz mono) chunks the admin plays as they arrive.
// Models and voice are set in Settings → AI assistant; costs count toward
// the daily cap (transcribing on the answer, speaking on a voice row).

// The voices OpenAI's audio models speak in through chat completions (the
// older text-to-speech voices fable, onyx and nova are not among them).
export const VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;
// About 75 s of 16 kHz mono 16-bit WAV.
export const MAX_AUDIO_BYTES = 2.5 * 1024 * 1024;
// Longer answers are cut at a sentence and the rest stays on screen. In
// spoken length: a Chinese, Japanese or Korean character takes about three
// times as long to say as a letter, so either way it is under ~2 minutes.
const MAX_SPOKEN = 1500;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const spokenWeight = (ch: string) => (CJK.test(ch) ? 3 : 1);
// A reading stops when OpenRouter sends nothing for this long, or runs past
// the cap (a full-length answer is about 100 s of speech).
const SPEAK_IDLE_MS = 30_000;
const SPEAK_TOTAL_MS = 180_000;

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

/** HTML a model slipped into its answer, as words: <br> is a pause, tags go.
 *  Repeated until nothing changes, then any stray angle bracket goes too, so
 *  no tag fragment survives (the text goes to a voice, never into HTML). */
function stripTags(s: string): string {
  let out = s.replace(/<br\s*\/?>/gi, ', ');
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<\/?[a-z][^<>]*>/gi, '');
  } while (out !== prev);
  return out.replace(/[<>]/g, '');
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
  let text = stripTags(
    lines
      .join('\n')
      // A < or > between numbers is a word, not a symbol to strip.
      .replace(
        /(\d)[ \t]*([<>])[ \t]*(?=(?:RM[ \t]*)?\d)/g,
        (_, d: string, op: string) =>
          `${d} ${op === '>' ? 'more than' : 'less than'} `,
      )
      .replace(/```[\s\S]*?```/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ''),
  )
    // Dashes and arrows between words are a pause, not a symbol to read.
    .replace(/\s*[—→]+\s*|\s+–\s+/g, ', ')
    .replace(/~~/g, '') // strikethrough; one ~ is "about" and stays
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  // Where the spoken budget runs out, and whether what is read is mostly
  // Chinese (the closing line follows it).
  let used = 0;
  let cjk = 0;
  let at = 0;
  for (const ch of text) {
    const w = spokenWeight(ch);
    if (used + w > MAX_SPOKEN) break;
    used += w;
    if (w > 1) cjk += w;
    at += ch.length;
  }
  if (at < text.length) {
    const cut = text.slice(0, at);
    let end = -1;
    // A . ? ! before a space (not 1,234.50) or a Chinese stop ends a sentence.
    for (const m of cut.matchAll(/[.?!](?=\s)|[。？！\n]/g)) end = m.index;
    const kept = cut.slice(0, end > 200 ? end + 1 : at);
    text =
      cjk * 2 > used
        ? `${kept}其余内容请看屏幕。`
        : `${kept} The rest is on screen.`;
  }
  return text;
}

function spokenLength(s: string): number {
  let n = 0;
  for (const ch of s) n += spokenWeight(ch);
  return n;
}

export type SpeechEvent =
  | { type: 'audio'; data: string }
  | { type: 'usage'; cost: number; tokensIn: number; tokensOut: number }
  | { type: 'generation'; id: string };

/** Reads `text` aloud: base64 PCM16 (24 kHz mono) chunks as they arrive,
 *  then what it cost. Throws when OpenRouter goes quiet for 30 s or the
 *  reading runs past 3 minutes. */
export async function* speak(opts: {
  key: string;
  model: string;
  voice: string;
  text: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<SpeechEvent> {
  const timeout = new AbortController();
  const stopAfter = (ms: number, why: string) =>
    setTimeout(() => timeout.abort(new Error(why)), ms);
  const total = stopAfter(
    SPEAK_TOTAL_MS,
    'Reading aloud took longer than 3 minutes.',
  );
  const quiet = 'OpenRouter sent no audio for 30 seconds.';
  let idle = stopAfter(SPEAK_IDLE_MS, quiet);
  const signal = AbortSignal.any([
    timeout.signal,
    ...(opts.signal ? [opts.signal] : []),
  ]);
  try {
    yield* speakUntil({ ...opts, signal }, () => {
      clearTimeout(idle);
      idle = stopAfter(SPEAK_IDLE_MS, quiet);
    });
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

async function* speakUntil(
  opts: {
    key: string;
    model: string;
    voice: string;
    text: string;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
  },
  heard: () => void,
): AsyncGenerator<SpeechEvent> {
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
          // ~2.5x what the text takes to say (~20 audio tokens a second):
          // text that tells the voice to go on can't make it talk forever.
          max_tokens: spokenLength(opts.text) * 4 + 200,
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
    heard();
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
