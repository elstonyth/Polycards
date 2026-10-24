import { useRef, type ChangeEvent } from 'react';
import { Button, IconButton, Input, toast } from '@medusajs/ui';
import { XMark } from '@medusajs/icons';
import { useUploadImage } from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import { Field } from '../../components/form-bits';
import {
  blankCredit,
  creditAmount,
  creditTitle,
  patchCredit,
  type PoolCredit,
} from './prize-pool';

const CreditRow = ({
  credit,
  onPatch,
  onRemove,
}: {
  credit: PoolCredit;
  /** Applied to the latest list by key (see patchCredit), never to `credit`
   *  as it was when the handler was made: an upload resolves much later. */
  onPatch: (patch: Partial<Omit<PoolCredit, 'key'>>) => void;
  onRemove: () => void;
}) => {
  const upload = useUploadImage();
  const fileRef = useRef<HTMLInputElement>(null);
  const amount = creditAmount(credit);

  // Same gate as the prize editor: instant client-side check, the server
  // re-validates and is authoritative.
  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const problem = await validateImageFile(file, 'card');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await upload.mutateAsync({ file, kind: 'card' });
      onPatch({ imageUrl: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <li className="border-ui-border-base flex flex-wrap items-end gap-3 rounded-md border p-3">
      <Field
        label="Amount (RM)"
        htmlFor={`${credit.key}-amount`}
        className="w-28"
      >
        <Input
          id={`${credit.key}-amount`}
          size="small"
          inputMode="decimal"
          aria-invalid={credit.amount !== '' && amount === null}
          value={credit.amount}
          onChange={(e) => onPatch({ amount: e.target.value })}
          placeholder="250"
        />
      </Field>
      <Field
        label="Title"
        htmlFor={`${credit.key}-title`}
        className="min-w-40 flex-1"
      >
        <Input
          id={`${credit.key}-title`}
          size="small"
          value={credit.title}
          maxLength={120}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder={creditTitle(amount ?? 250)}
        />
      </Field>
      <Field label="Art (optional — coins if empty)">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFile}
        />
        <div className="flex items-center gap-x-2">
          {credit.imageUrl && (
            <img
              src={resolveImageUrl(credit.imageUrl)}
              alt=""
              className="h-10 w-7 rounded object-contain"
            />
          )}
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={() => fileRef.current?.click()}
            isLoading={upload.isPending}
          >
            {credit.imageUrl ? 'Replace…' : 'Upload…'}
          </Button>
          {credit.imageUrl && (
            <Button
              size="small"
              variant="transparent"
              type="button"
              onClick={() => onPatch({ imageUrl: '' })}
            >
              Use coins
            </Button>
          )}
        </div>
      </Field>
      <IconButton
        size="small"
        variant="transparent"
        aria-label="Remove credit prize"
        onClick={onRemove}
      >
        <XMark />
      </IconButton>
    </li>
  );
};

/** Bonus-credit prizes for a new event: an amount, a title (defaults to
 *  "RM <amount> bonus credit") and optional art (the coins when empty). */
export const CreditPrizeRows = ({
  credits,
  onChange,
  canAddMore,
}: {
  credits: PoolCredit[];
  /** A state setter's updater form: every change is made on the latest list. */
  onChange: (update: (prev: PoolCredit[]) => PoolCredit[]) => void;
  /** false once the pool is full. */
  canAddMore: boolean;
}) => (
  <div className="flex flex-col gap-y-3">
    {credits.length > 0 && (
      <ul className="flex flex-col gap-y-2">
        {credits.map((c) => (
          <CreditRow
            key={c.key}
            credit={c}
            onPatch={(patch) =>
              onChange((prev) => patchCredit(prev, c.key, patch))
            }
            onRemove={() =>
              onChange((prev) => prev.filter((x) => x.key !== c.key))
            }
          />
        ))}
      </ul>
    )}
    <div>
      <Button
        size="small"
        variant="secondary"
        type="button"
        disabled={!canAddMore}
        onClick={() => onChange((prev) => [...prev, blankCredit()])}
      >
        Add credit prize
      </Button>
    </div>
  </div>
);
