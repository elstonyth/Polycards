import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FocusModal, Heading } from '@medusajs/ui';
import { resolveImageUrl } from '../lib/image-url';

/** A card picture, whole (object-contain: a slab is taller than a card), that
 *  opens full size when tapped. className sizes the thumbnail. Renders nothing
 *  without a usable URL: an empty string resolves to the page URL and gets
 *  refetched as an image. */
export const CardImage = ({
  src,
  name,
  className,
  lazy = false,
}: {
  src: string | null | undefined;
  name: string;
  className: string;
  lazy?: boolean;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const url = resolveImageUrl(src);
  if (!url) return null;

  return (
    // stopPropagation: a table row that navigates on click must not fire too,
    // and React bubbles the modal's clicks up through its portal to that row.
    <span className="inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={t('cardImage.view', { name })}
        className="block cursor-zoom-in rounded"
        onClick={() => setOpen(true)}
      >
        <img
          src={url}
          alt=""
          loading={lazy ? 'lazy' : undefined}
          decoding="async"
          className={`${className} object-contain`}
        />
      </button>
      <FocusModal open={open} onOpenChange={setOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <FocusModal.Title asChild>
              <Heading level="h2" className="break-words">
                {name}
              </Heading>
            </FocusModal.Title>
          </FocusModal.Header>
          <FocusModal.Body className="min-h-0 p-6">
            <img
              src={url}
              alt={name}
              decoding="async"
              className="h-full w-full object-contain"
            />
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </span>
  );
};
