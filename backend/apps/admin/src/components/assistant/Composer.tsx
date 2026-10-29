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

const MAX_IMAGES = 4;

// The question box (21st.dev "AI prompt input" + "border beam" patterns):
// grows with the text, takes screenshots by paste, drop or the picture
// button, sends on Enter (Shift+Enter for a new line), and turns into a stop
// button while an answer streams.
export function Composer({
  busy,
  onSend,
  onStop,
  autoFocus,
  seed,
}: {
  busy: boolean;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  autoFocus?: boolean;
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

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    area.current?.focus();
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
    if (!q || busy) return;
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
                    className="bg-ui-bg-base border-ui-border-base text-ui-fg-subtle absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm"
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
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                aria-label={t('assistant.stop')}
                className="text-ui-fg-base transition-transform hover:scale-105"
              >
                <StopCircleSolid className="h-7 w-7" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!text.trim()}
                aria-label={t('assistant.send')}
                className="text-violet-500 transition-transform hover:scale-105 disabled:text-ui-fg-disabled disabled:hover:scale-100"
              >
                <ArrowUpCircleSolid className="h-7 w-7" />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
