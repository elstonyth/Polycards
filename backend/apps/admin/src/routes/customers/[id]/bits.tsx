import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Copy, Drawer, Input, Label, Prompt, Text } from '@medusajs/ui';
import { orderDateTime, timeAgo } from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { useRestoreFocus } from './row-helpers';

// The small pieces every tab on the player page shares.

/** A date a person can quote, and how long ago it was. */
export const When = ({ iso }: { iso: string }) => (
  <>
    <div className="tabular-nums">{orderDateTime(iso)}</div>
    <div className="text-ui-fg-subtle txt-compact-xsmall">{timeAgo(iso)}</div>
  </>
);

export const FilterPills = <T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) => (
  <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
    {options.map((o) => (
      <Button
        key={o.value}
        size="small"
        variant={value === o.value ? 'primary' : 'secondary'}
        aria-pressed={value === o.value}
        onClick={() => onChange(o.value)}
      >
        {o.label}
      </Button>
    ))}
  </div>
);

export const DetailDrawer = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) => {
  const restoreFocus = useRestoreFocus();
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content onCloseAutoFocus={restoreFocus}>
        <Drawer.Header>
          <Drawer.Title>{title}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="divide-y overflow-y-auto p-0">
          {children}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer>
  );
};

export const DetailRows = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 break-words px-6 py-4 text-sm">
    {children}
  </dl>
);

/** One fact. An empty one is left out rather than shown as a dash. `code` is a
 *  reference staff paste elsewhere: mono, with a copy button. */
export const DetailRow = ({
  label,
  value,
  code,
}: {
  label: string;
  value?: ReactNode;
  code?: string | null;
}) => {
  if (!code && (value === null || value === undefined || value === ''))
    return null;
  return (
    <>
      <dt className="text-ui-fg-subtle">{label}</dt>
      <dd className="min-w-0">
        {code ? (
          <span className="flex items-start gap-1.5">
            <span className="min-w-0 break-all font-mono text-xs">{code}</span>
            <Copy content={code} className="shrink-0" />
          </span>
        ) : (
          value
        )}
      </dd>
    </>
  );
};

export const CardLine = ({
  name,
  image,
  note,
}: {
  name: string;
  image?: string | null;
  note?: ReactNode;
}) => (
  <div className="flex items-center gap-3">
    {/* An empty image would render <img src="">, which refetches the page. */}
    {image ? (
      <img
        src={resolveImageUrl(image)}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-20 w-14 shrink-0 rounded object-contain"
      />
    ) : (
      <span className="bg-ui-bg-component h-20 w-14 shrink-0 rounded" />
    )}
    <div className="min-w-0">
      <div className="text-sm">{name}</div>
      {note && (
        <div className="text-ui-fg-subtle txt-compact-xsmall">{note}</div>
      )}
    </div>
  </div>
);

export type DialogField = {
  key: string;
  label: string;
  initial?: string;
  placeholder?: string;
  /** May be left blank (for example "blank = no referrer"). */
  optional?: boolean;
  /** Keeps Apply off until the trimmed value passes. */
  valid?: (value: string) => boolean;
};

/** Asks for the values of an audited action, reason included, then runs it.
 *  Render it only while open, so its fields start from `initial`. It stays open
 *  until the caller closes it: a refused save keeps what was typed. */
export const FieldsDialog = ({
  title,
  description,
  fields,
  busy,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  fields: DialogField[];
  busy?: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  );
  const restoreFocus = useRestoreFocus();
  const ready =
    !busy &&
    fields.every((f) => {
      const value = values[f.key].trim();
      return (f.optional || !!value) && (f.valid?.(value) ?? true);
    });
  const submit = () => {
    if (ready) {
      onSubmit(
        Object.fromEntries(fields.map((f) => [f.key, values[f.key].trim()])),
      );
    }
  };
  return (
    <Prompt open variant="confirmation" onOpenChange={(o) => !o && onClose()}>
      <Prompt.Content onCloseAutoFocus={restoreFocus}>
        <Prompt.Header>
          <Prompt.Title>{title}</Prompt.Title>
          <Prompt.Description>{description ?? ''}</Prompt.Description>
        </Prompt.Header>
        <div className="flex flex-col gap-3 px-6 pb-2">
          {fields.map((f, i) => (
            <div key={f.key} className="flex flex-col gap-1">
              <Label htmlFor={`dialog-${f.key}`} size="small">
                {f.label}
              </Label>
              <Input
                id={`dialog-${f.key}`}
                value={values[f.key]}
                placeholder={f.placeholder}
                autoFocus={i === 0}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.key]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </div>
          ))}
        </div>
        <Prompt.Footer>
          <Prompt.Cancel>{t('support.adjustCancel')}</Prompt.Cancel>
          <Prompt.Action
            disabled={!ready}
            onClick={(e) => {
              // Radix closes on click otherwise; see the note above.
              e.preventDefault();
              submit();
            }}
          >
            {t('support.adjustConfirm')}
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  );
};

/** A failed read or an empty list, where a table would be. */
export const TableState = ({
  isError,
  empty,
}: {
  isError?: boolean;
  empty?: string;
}) => {
  const { t } = useTranslation();
  return (
    <div className="border-t px-6 py-6">
      {isError ? (
        <Text size="small" className="text-ui-fg-error">
          {t('playerDetail.loadError')}
        </Text>
      ) : (
        <Text className="text-ui-fg-subtle">{empty}</Text>
      )}
    </div>
  );
};
