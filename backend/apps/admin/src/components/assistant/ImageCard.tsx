import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowDownTray } from '@medusajs/icons';
import { useTranslation } from 'react-i18next';
import { resolveImageUrl } from '../../lib/image-url';

// A poster or AI image the assistant made (stored by the server, so only our
// own file storage ever loads here), with a download that saves the file
// rather than opening it.
export function ImageCard({ url }: { url: string }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = resolveImageUrl(url);
  const download = async () => {
    try {
      const res = await fetch(src);
      // An error page saved as .jpg is worse than opening the image.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const href = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), {
        href,
        download:
          url.split('/').pop()?.split(/[?#]/)[0] || 'polycards-image.jpg',
      });
      a.click();
      // Some browsers start the save after click() returns.
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      window.open(src, '_blank', 'noopener,noreferrer');
    }
  };
  if (!src) return null;
  return (
    <motion.figure
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="border-ui-border-base bg-ui-bg-component group relative w-full max-w-[320px] overflow-hidden rounded-2xl border shadow-sm"
    >
      {failed ? (
        <div className="text-ui-fg-muted flex aspect-[4/5] w-full items-center justify-center p-6 text-center text-xs">
          {t('assistant.imageFailed')}
        </div>
      ) : (
        !loaded && <div className="pc-ai-scan aspect-[4/5] w-full" />
      )}
      <img
        src={src}
        alt=""
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={loaded ? 'block w-full' : 'absolute h-0 w-0 opacity-0'}
      />
      <button
        type="button"
        onClick={download}
        className="absolute bottom-2 right-2 flex items-center gap-x-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white opacity-0 backdrop-blur transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <ArrowDownTray />
        {t('assistant.download')}
      </button>
    </motion.figure>
  );
}

/** Where an image is still being drawn. */
export function ImagePending({ label }: { label: string }) {
  return (
    <div className="border-ui-border-base relative w-full max-w-[320px] overflow-hidden rounded-2xl border">
      <div className="pc-ai-scan aspect-[4/5] w-full" />
      <span className="pc-ai-shimmer absolute inset-x-0 bottom-4 text-center text-xs font-medium">
        {label}
      </span>
    </div>
  );
}
