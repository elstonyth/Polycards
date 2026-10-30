import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUpCircleSolid,
  Photo,
  StopCircleSolid,
  XMarkMini,
} from '@medusajs/icons';
import { toast } from '@medusajs/ui';
import { useTranslation } from 'react-i18next';
import { imageToDataUrl } from '../../lib/assistant';
import { classifyPaste } from './paste';
import { MicIcon } from './VoiceIcons';

const MAX_IMAGES = 4;

// Read while the event lives (the object is dead after an await). `items`
// and `files` mirror each other, but some sources fill only `items`.
const imagesOf = (d: DataTransfer): File[] => {
  const fromItems = [...d.items]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
  return fromItems.length
    ? fromItems
    : [...d.files].filter((f) => f.type.startsWith('image/'));
};

// The question box (21st.dev "AI prompt input" + "border beam" patterns):
// grows with the text, takes screenshots by paste, drop or the picture
// button, sends on Enter (Shift+Enter for a new line), and turns into a stop
// button while an answer streams. The mic asks by voice: it records until
// the speaker goes quiet (or a second tap) and the answer is read aloud.
export function Composer({
  busy,
  onSend,
  onStop,
  autoFocus,
  seed,
  disabled,
  mic,
  lastQuestion,
}: {
  busy: boolean;
  /** Put back by ArrowUp in an empty box. */
  lastQuestion?: string;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  mic?: { listening: boolean; level: number; onClick: () => void };
  autoFocus?: boolean;
  /** Hold sending (a chat is still loading); typing stays open. */
  disabled?: boolean;
  /** Text to put in the box (a suggestion that needs a name first). */
  seed?: { text: string; n: number };
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // A new suggestion replaces the text while rendering (React's "adjust
  // state when a prop changes"), not in an effect.
  const [seededN, setSeededN] = useState(seed?.n);
  if (seed && seed.n !== seededN) {
    setSeededN(seed.n);
    setText(seed.text);
  }
  useEffect(() => {
    if (seed) area.current?.focus();
  }, [seed]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Pictures still decoding: send waits for them, so a paste then a quick
  // Enter neither drops the picture nor hands it to the next question.
  const [decoding, setDecoding] = useState(0);

  /** Image files, or data: URLs lifted from pasted HTML. */
  const add = async (picks: (File | string)[]) => {
    if (!picks.length) return;
    const room = MAX_IMAGES - images.length;
    if (picks.length > room) {
      toast.warning(t('assistant.tooManyImages', { n: MAX_IMAGES }));
    }
    setDecoding((n) => n + 1);
    // Capped before any fetch; one bad picture does not lose the rest.
    const results = await Promise.allSettled(
      picks.slice(0, room).map(async (p) => {
        if (typeof p !== 'string') return imageToDataUrl(p);
        const blob = await (await fetch(p)).blob();
        return imageToDataUrl(new File([blob], 'pasted', { type: blob.type }));
      }),
    );
    setDecoding((n) => n - 1);
    const urls = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    setImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
    if (urls.length < results.length) {
      toast.error(t('assistant.imageUnreadable'));
    }
  };

  /** Pastes or drops: images attach, text stays (a sheet range: text only). */
  const take = (d: DataTransfer) => {
    const files = imagesOf(d);
    const keep = classifyPaste({
      html: d.getData('text/html'),
      text: d.getData('text/plain'),
      imageCount: files.length,
    });
    if (keep.files) void add(files);
    else if (keep.inline.length) void add(keep.inline);
    return keep;
  };

  const send = () => {
    const q = text.trim();
    if (!q || busy || disabled || decoding > 0) return;
    onSend(q, images);
    setText('');
    setImages([]);
  };

  return (
    <div
      className="pc-ai-beam rounded-2xl p-px shadow-lg"
      data-active={busy || focused || dragging}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => {
        setDragging(false);
        // Text dragged within the box: the browser moves it itself.
        if (e.target === area.current && !e.dataTransfer.files.length) return;
        // Else always: a dropped file would otherwise open in the tab.
        e.preventDefault();
        if (!take(e.dataTransfer).text) return;
        const dropped = e.dataTransfer.getData('text/plain');
        setText((v) => (v.trim() ? `${v}\n${dropped}` : dropped));
      }}
    >
      <div className="bg-ui-bg-base flex flex-col gap-y-2 rounded-[15px] p-3">
        <AnimatePresence initial={false}>
          {images.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="flex gap-x-2"
            >
              {images.map((src, i) => (
                <div key={src.slice(-32) + i} className="relative">
                  <img
                    src={src}
                    alt=""
                    className="border-ui-border-base h-14 w-14 rounded-lg border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={t('assistant.removeImage')}
                    onClick={() =>
                      setImages((p) => p.filter((_, j) => j !== i))
                    }
                    className="bg-ui-bg-base border-ui-border-base text-ui-fg-subtle absolute -right-1.5 -top-1.5 flex h-5 !min-h-0 w-5 items-center justify-center rounded-full border shadow-sm"
                  >
                    <XMarkMini />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <textarea
          ref={area}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={t('assistant.placeholder')}
          aria-label={t('assistant.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e: ClipboardEvent) => {
            // Kept text is left to the browser's own paste: it lands at the
            // cursor with its tabs and line breaks, so a sheet reads as one.
            const keep = take(e.clipboardData);
            if (!keep.text && (keep.files || keep.inline.length)) {
              e.preventDefault();
            }
          }}
          onKeyDown={(e) => {
            // keyCode 229: Safari's Enter that commits a Chinese IME word.
            const plain =
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229 &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey;
            if (plain && e.key === 'Escape' && busy) {
              e.preventDefault();
              onStop();
              return;
            }
            if (plain && e.key === 'ArrowUp' && !text && lastQuestion) {
              e.preventDefault();
              setText(lastQuestion);
              return;
            }
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              send();
            }
          }}
          className="text-ui-fg-base placeholder:text-ui-fg-muted w-full resize-none bg-transparent px-1 text-[14px] leading-6 outline-none"
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={images.length >= MAX_IMAGES}
            className="text-ui-fg-subtle hover:text-ui-fg-base hover:bg-ui-bg-base-hover flex items-center gap-x-1.5 rounded-lg px-2 py-1 text-xs disabled:opacity-40"
          >
            <Photo />
            {t('assistant.attach')}
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) {
                void add(
                  [...e.target.files].filter((f) =>
                    f.type.startsWith('image/'),
                  ),
                );
              }
              e.target.value = '';
            }}
          />
          <span className="flex items-center gap-x-3">
            <span className="text-ui-fg-muted hidden text-[11px] sm:inline">
              {t('assistant.enterHint')}
            </span>
            {mic && (
              <button
                type="button"
                onClick={mic.onClick}
                aria-pressed={mic.listening}
                aria-disabled={!mic.listening && (busy || disabled)}
                aria-label={
                  mic.listening
                    ? t('assistant.voice.stopMic')
                    : t('assistant.voice.mic.ask')
                }
                className={`relative flex h-7 w-7 items-center justify-center rounded-full transition-colors aria-disabled:opacity-40 ${mic.listening ? 'bg-sky-500 text-white' : 'text-ui-fg-subtle hover:text-ui-fg-base hover:bg-ui-bg-base-hover'}`}
              >
                {mic.listening && (
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-full bg-sky-400/40 motion-safe:transition-transform"
                    style={{
                      transform: `scale(${1 + Math.min(mic.level, 1) * 0.6})`,
                    }}
                  />
                )}
                <MicIcon className="relative" />
              </button>
            )}
            {/* One button that turns into Stop, so a mouse send keeps focus;
                aria-disabled (send() checks itself) so the end keeps it too. */}
            <button
              type="button"
              onClick={busy ? onStop : send}
              aria-disabled={
                !busy && (!text.trim() || disabled || decoding > 0)
              }
              aria-label={busy ? t('assistant.stop') : t('assistant.send')}
              className={`${busy ? 'text-ui-fg-base' : 'text-violet-500'} aria-disabled:text-ui-fg-disabled transition-transform hover:scale-105 aria-disabled:hover:scale-100`}
            >
              {busy ? (
                <StopCircleSolid className="h-7 w-7" />
              ) : (
                <ArrowUpCircleSolid className="h-7 w-7" />
              )}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
