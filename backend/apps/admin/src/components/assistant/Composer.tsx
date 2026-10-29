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
import { MicIcon } from './VoiceIcons';

const MAX_IMAGES = 4;

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
}: {
  busy: boolean;
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

  const add = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const room = MAX_IMAGES - images.length;
    if (list.length > room) {
      toast.warning(t('assistant.tooManyImages', { n: MAX_IMAGES }));
    }
    try {
      const urls = await Promise.all(list.slice(0, room).map(imageToDataUrl));
      setImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
    } catch {
      toast.error(t('assistant.imageUnreadable'));
    }
  };

  const send = () => {
    const q = text.trim();
    if (!q || busy || disabled) return;
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
        e.preventDefault();
        setDragging(false);
        void add(e.dataTransfer.files);
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
            // A copied spreadsheet range carries its text AND a picture of
            // it: keep the text. Only a pasted picture becomes an image.
            if (
              e.clipboardData.files.length &&
              !e.clipboardData.getData('text/plain').trim()
            ) {
              e.preventDefault();
              void add(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            // keyCode 229: Safari's Enter that commits a Chinese IME word.
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
              if (e.target.files) void add(e.target.files);
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
                    style={{ transform: `scale(${1 + Math.min(mic.level, 1) * 0.6})` }}
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
              aria-disabled={!busy && (!text.trim() || disabled)}
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
