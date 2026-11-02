import {
  MODEL_RE,
  openRouterUrl,
  OpenRouterError,
  speechModels,
  speechUrl,
  type SpeechModel,
} from './openrouter';

// Voice (owner, 2026-10-29: "able to answer and reply, listening"):
//  - transcribe(): the admin records the question as 16 kHz WAV; a listening
//    model writes down what was said (chat completions, input_audio), and
//    that text is asked. Tested 2026-10-29 on questions and instructions: it
//    writes them down, it does not answer them.
//  - speak(): a speaking model reads an answer aloud through OpenRouter's
//    /audio/speech, streamed as raw PCM16 mono the admin plays as it
//    arrives. Not a chat voice model: tested 2026-10-29, gpt-audio-mini
//    answered a question it was given to read and told the joke a sentence
//    asked for; speech models read the text as written.
// Models and voice are set in Settings → AI assistant; costs count toward
// the daily cap (transcribing on the answer, speaking on a voice row).

export const DEFAULT_VOICE_MODEL = 'google/gemini-3.8-flash-lite-tts';
export const DEFAULT_VOICE = 'Kore';
// A voice name as OpenRouter lists them (Kore, en_paul_neutral,
// en-US-Harper:MAI-Voice-2.1).
const VOICE_RE = /^[\w.:-]{1,80}$/;
// Speech without a rate on its content type is 24 kHz, as all of
// OpenRouter's PCM voices were on 2026-10-29.
const DEFAULT_RATE = 24000;
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
// A speech model's first sound comes later the more text it is given
// (measured 2026-10-29: 4 s for a line, 12-20 s for a full answer), so an
// answer is read in pieces: a short first one, so the voice starts soon,
// then longer ones, each fetched while the one before plays. In spoken
// length (spokenWeight).
const FIRST_PIECE = 120;
const PIECE = 360;

const LISTEN_PROMPT =
  'You write down speech. Return exactly what the speaker said, in the language they spoke (English, Malay, Chinese or a mix), with punctuation. Do not translate, answer, summarise or comment. If nothing was said, return an empty reply. Write Chinese in simplified characters. ' +
  // House words the listening model would otherwise misspell.
  'The speaker works at Polycards, a trading card shop. Spell these as written: Polycards, PSA, BGS, CGC, TNG, Maybank, Pokémon, One Piece, Pikachu, Charizard, slab, pack, vault, buyback, top-up, RM, sen. Write spoken numbers and amounts as digits (RM 1,250.50, 3 packs).';

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
    cost: Math.max(0, Number(body.usage?.cost ?? 0) || 0),
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

// An amount: 1,250 or 1250, with up to 2 decimals, and not followed by
// more digits (RM 12.505 is left alone rather than read as 12.50).
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d|[.,]\d)`;
// A range: RM 10-20, RM 10–RM 20, RM 10 – RM 20, RM 10 to RM 20. A spaced
// hyphen or an em dash is not one: RM 500 - RM 120 is a sum.
const RANGE_RE = new RegExp(
  String.raw`\bRM[ \t]*${AMOUNT}(?:[–-](?:RM[ \t]*)?|[ \t]+–[ \t]+RM[ \t]*|[ \t]+to[ \t]+RM[ \t]*)${AMOUNT}`,
  'g',
);
const MONEY_RE = new RegExp(
  String.raw`\bRM[ \t]*(-)?[ \t]*${AMOUNT}(?:[ \t]?(million|mil|[mM]|billion|bn|thousand|[kK]|juta)(?![A-Za-z])|([万千亿]))?`,
  'g',
);
const SCALE: Record<string, string> = {
  million: 'million',
  mil: 'million',
  m: 'million',
  billion: 'billion',
  bn: 'billion',
  thousand: 'thousand',
  k: 'thousand',
  juta: 'juta',
};
const HAN = /\p{Script=Han}/gu;
const LATIN = /\p{Script=Latin}/gu;

/** RM amounts as people say them: a speech model reads "RM 12.50" in an
 *  English sentence as dollars (tested 2026-10-29), so 12 ringgit 50 sen,
 *  in a Chinese line 12令吉50仙, a range 10 to 20 ringgit, RM 2.5m 2.5
 *  million ringgit. A line is Chinese when its Chinese characters outweigh
 *  its Latin letters (a character takes ~3x a letter to say), so one name
 *  in Chinese, or a Japanese card name, leaves an English line English. */
function sayMoney(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const zh =
        (line.match(HAN)?.length ?? 0) * 3 > (line.match(LATIN)?.length ?? 0);
      const unit = zh ? '令吉' : ' ringgit';
      const sen = (cents?: string) => {
        const n = cents ? Number(cents.padEnd(2, '0')) : 0;
        return !n ? '' : zh ? `${n}仙` : ` ${n} sen`;
      };
      const exact = (whole: string, cents?: string) =>
        cents ? `${whole}.${cents}` : whole;
      return line
        .replace(
          RANGE_RE,
          (_, a: string, ac: string | undefined, b: string, bc?: string) =>
            `${exact(a, ac)}${zh ? '至' : ' to '}${exact(b, bc)}${unit}`,
        )
        .replace(
          MONEY_RE,
          (
            _,
            minus: string | undefined,
            a: string,
            ac?: string,
            scale?: string,
            zhScale?: string,
          ) => {
            const sign = minus ? (zh ? '负' : 'minus ') : '';
            if (scale || zhScale)
              return `${sign}${exact(a, ac)}${zhScale ?? ` ${SCALE[(scale as string).toLowerCase()]}`}${unit}`;
            // RM 0.50: 50 sen
            if (a === '0' && sen(ac)) return `${sign}${sen(ac).trim()}`;
            return `${sign}${a}${unit}${sen(ac)}`;
          },
        )
        .replace(/\bRM\b/g, zh ? '令吉' : 'ringgit');
    })
    .join('\n');
}

/** Markdown as it should be heard: no symbols, tables read row by row,
 *  links by their words, money as it is said, long answers cut at a
 *  sentence. */
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
  let text = sayMoney(
    stripTags(
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
    ),
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

export function spokenLength(s: string): number {
  let n = 0;
  for (const ch of s) n += spokenWeight(ch);
  return n;
}

/** Where to cut a sentence too long for one piece: the last pause that fits
 *  in max, or as much as fits. Never 0, so cutting always moves on. A , ; or
 *  : is a pause only before a space, so 12,345 and 10:30 stay whole. */
function cutAt(s: string, max: number): number {
  const chars = [...s];
  let used = 0;
  let at = 0;
  let pause = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const w = spokenWeight(ch);
    if (used + w > max) break;
    used += w;
    at += ch.length;
    if (
      /[，；、：\s]/.test(ch) ||
      (/[,;:]/.test(ch) && /\s/.test(chars[i + 1] ?? ''))
    )
      pause = at;
  }
  return pause > at / 3 ? pause : Math.max(at, 1);
}

/** The text in reading order, in pieces cut at sentence ends: the first at
 *  most FIRST_PIECE in spoken length, the rest PIECE. A sentence longer than
 *  that is cut at a comma or a space. */
export function speechPieces(text: string): string[] {
  const sentences: string[] = [];
  let from = 0;
  // A . ? ! before a space (not 1,234.50) or a Chinese stop ends a sentence.
  for (const m of text.matchAll(/[.?!](?=\s)|[。？！\n]/g)) {
    const end = m.index + m[0].length;
    sentences.push(text.slice(from, end));
    from = end;
  }
  sentences.push(text.slice(from));
  const pieces: string[] = [];
  let piece = '';
  const limit = () => (pieces.length ? PIECE : FIRST_PIECE);
  const flush = () => {
    if (piece.trim()) pieces.push(piece.trim());
    piece = '';
  };
  for (let sentence of sentences) {
    while (spokenLength(piece + sentence) > limit()) {
      if (piece.trim()) {
        flush();
        continue;
      }
      const cut = cutAt(sentence, limit());
      piece = sentence.slice(0, cut);
      sentence = sentence.slice(cut);
      flush();
    }
    piece += sentence;
  }
  flush();
  return pieces;
}

/** Why this speaking model and voice can't be used (a message for the
 *  admin), or null when they can. Checked against OpenRouter's list of
 *  speaking models when it can be had (a chat model like gpt-audio-mini is
 *  not on it), else by form only. */
export async function speechChoiceProblem(
  model: unknown,
  voice: unknown,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (typeof model !== 'string' || model.length > 100 || !MODEL_RE.test(model))
    return `voice_model must be an OpenRouter speaking model like ${DEFAULT_VOICE_MODEL}.`;
  if (typeof voice !== 'string' || !VOICE_RE.test(voice))
    return 'voice must be one of the speaking model’s voices.';
  const models = await speechModels(fetchImpl);
  if (!models) return null;
  const found = models.get(model);
  if (!found)
    return `${model} is not one of OpenRouter's speaking models. Pick one from the list.`;
  if (found.voices && !found.voices.includes(voice))
    return `${voice} is not a voice of ${model}. Pick one of its voices.`;
  return null;
}

// The dearest per-character voices OpenRouter listed on 2026-10-29
// (MiniMax Speech HD): the price of a reading whose own is unknown.
const DEAREST_PER_CHAR = 0.0001;

/** A safe overestimate of what a reading cost, counted toward the daily cap
 *  until OpenRouter's own figure arrives: the input at the model's prompt
 *  price per character (it bills tokens or characters, never more of them
 *  than characters), and the output at its completion price for 25 audio
 *  tokens a second. A model with no price listed, or a list out of reach,
 *  counts at DEAREST_PER_CHAR: never 0, never negative. */
export function estimateSpeechCost(
  model: SpeechModel | undefined,
  chars: number,
  seconds: number,
): number {
  const listed = model
    ? Math.max(0, model.prompt) * chars +
      Math.max(0, model.completion) * 25 * seconds
    : 0;
  return listed > 0 ? listed : chars * DEAREST_PER_CHAR;
}

export type SpeechEvent =
  | { type: 'piece' } // about to ask for the next piece: from here it may be billed
  | { type: 'format'; rate: number }
  | { type: 'audio'; data: string }
  | { type: 'generation'; id: string };

/** Reads `text` aloud through /audio/speech, piece by piece (speechPieces):
 *  a piece event as each piece is asked for, its sample rate, base64 PCM16
 *  mono chunks as they arrive, and each piece's generation id (what it cost
 *  is looked up later: speech returns no usage). Throws when OpenRouter goes quiet for 30 s or
 *  the reading runs past 3 minutes. */
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
  let rate = 0;
  for (const piece of speechPieces(opts.text)) {
    opts.signal.throwIfAborted();
    yield { type: 'piece' };
    const answer = await retryOnce(
      () =>
        (opts.fetchImpl ?? fetch)(speechUrl(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.key}`,
            'content-type': 'application/json',
            'x-title': 'Polycards admin assistant',
          },
          body: JSON.stringify({
            model: opts.model,
            input: piece,
            voice: opts.voice,
            response_format: 'pcm',
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
    const id = answer.headers.get('x-generation-id');
    if (id) yield { type: 'generation', id };
    const type = answer.headers.get('content-type') ?? '';
    // raw little-endian PCM16 only (audio/L16 would be big-endian)
    if (!/^audio\/pcm\b/i.test(type)) {
      await answer.body.cancel().catch(() => undefined);
      throw new OpenRouterError(
        `The speaking model sent ${type || 'no'} audio, not PCM. Pick another speaking model.`,
      );
    }
    const pieceRate = Number(/rate=(\d+)/i.exec(type)?.[1]) || DEFAULT_RATE;
    if (!rate) {
      rate = pieceRate;
      yield { type: 'format', rate };
    } else if (pieceRate !== rate) {
      await answer.body.cancel().catch(() => undefined);
      throw new OpenRouterError(
        'The speaking model changed its sample rate mid-answer.',
      );
    }
    const reader = answer.body.getReader();
    let ended = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        heard();
        if (value?.length)
          yield { type: 'audio', data: Buffer.from(value).toString('base64') };
        if (done) break;
      }
      ended = true;
    } finally {
      // a consumer that stops early must not leave the connection open
      if (!ended) await reader.cancel().catch(() => undefined);
    }
  }
}
