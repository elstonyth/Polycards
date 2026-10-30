import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Text,
  Textarea,
  toast,
} from '@medusajs/ui';
import { PlusMini, XMarkMini } from '@medusajs/icons';
import type { AssistantSettings } from '../../../lib/assistant';
import { uploadImage } from '../../../lib/admin-rest';
import { resolveImageUrl } from '../../../lib/image-url';

const MAX_REFS = 6;

// Settings → AI → Image style (owner, 2026-10-29): AI images follow the
// brand's Instagram look. The rules text and the reference posts the image
// model matches; both start from defaults written from the posted posters.
export function ImageStyleCard({
  settings,
  save,
}: {
  settings: AssistantSettings;
  save: (patch: {
    image_style?: string | null;
    style_refs?: string[] | null;
  }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // Seeded once: saving must not wipe text being edited.
  const [style, setStyle] = useState(
    settings.image_style ?? settings.image_style_default,
  );
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const custom = settings.style_refs;
  const shown = custom.length
    ? custom.map((url) => ({ url, note: '' }))
    : settings.style_refs_default;

  const run = async (patch: Parameters<typeof save>[0]) => {
    setBusy(true);
    try {
      return await save(patch);
    } finally {
      setBusy(false);
    }
  };

  const add = async (file: File) => {
    setBusy(true);
    try {
      const url = await uploadImage(file, 'announcement');
      await save({ style_refs: [...custom, url].slice(0, MAX_REFS) });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container className="flex flex-col gap-y-4 px-6 py-5">
      <div>
        <Heading level="h3">{t('assistant.settings.styleTitle')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('assistant.settings.styleHelp')}
        </Text>
      </div>
      <Textarea
        aria-label={t('assistant.settings.styleTitle')}
        rows={9}
        value={style}
        onChange={(e) => setStyle(e.target.value)}
        className="font-mono text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="small"
          disabled={busy || !style.trim() || style.length > 4000}
          onClick={() =>
            void run({
              image_style:
                style.trim() === settings.image_style_default.trim()
                  ? null
                  : style,
            })
          }
        >
          {t('assistant.settings.styleSave')}
        </Button>
        <Button
          variant="transparent"
          size="small"
          disabled={busy || settings.image_style === null}
          onClick={async () => {
            if (await run({ image_style: null })) {
              setStyle(settings.image_style_default);
            }
          }}
        >
          {t('assistant.settings.styleReset')}
        </Button>
      </div>

      <div className="border-ui-border-base border-t pt-4">
        <Heading level="h3">{t('assistant.settings.refsTitle')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {custom.length
            ? t('assistant.settings.refsHelp')
            : `${t('assistant.settings.refsDefault')} · ${t('assistant.settings.refsHelp')}`}
        </Text>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('assistant.settings.refsReplace')}
        </Text>
      </div>
      <div className="flex flex-wrap gap-3">
        {shown.map((r, i) => (
          <figure
            key={r.url.slice(-40) + i}
            className="border-ui-border-base relative w-28 overflow-hidden rounded-xl border"
            title={r.note || undefined}
          >
            <img
              src={r.url.startsWith('data:') ? r.url : resolveImageUrl(r.url)}
              alt={r.note}
              className="aspect-[2/3] w-full object-cover"
            />
            {custom.length > 0 && (
              <button
                type="button"
                aria-label={t('assistant.settings.refsRemove')}
                disabled={busy}
                onClick={() =>
                  void run({ style_refs: custom.filter((_, j) => j !== i) })
                }
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white"
              >
                <XMarkMini />
              </button>
            )}
          </figure>
        ))}
        {custom.length < MAX_REFS && (
          <button
            type="button"
            disabled={busy}
            onClick={() => picker.current?.click()}
            className="border-ui-border-base text-ui-fg-subtle hover:text-ui-fg-base hover:border-ui-border-interactive flex aspect-[2/3] w-28 flex-col items-center justify-center gap-y-1 rounded-xl border border-dashed text-xs disabled:opacity-50"
          >
            <PlusMini />
            {t('assistant.settings.refsAdd')}
          </button>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void add(file);
          }}
        />
      </div>
      {custom.length > 0 && (
        <div>
          <Button
            variant="transparent"
            size="small"
            disabled={busy}
            onClick={() => void run({ style_refs: null })}
          >
            {t('assistant.settings.refsUseDefault')}
          </Button>
        </div>
      )}
    </Container>
  );
}
