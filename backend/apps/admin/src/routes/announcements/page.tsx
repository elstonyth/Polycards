import { useRef, useState, type ChangeEvent } from 'react';
import {
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  StatusBadge,
  Switch,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import { BellAlert, XMark } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useAnnouncements,
  useDeleteAnnouncement,
  useSaveAnnouncement,
  useUploadImage,
  type AdminAnnouncement,
} from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import { scheduleOk, toIso, toLocalInput } from '../tasks/task-draft';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { RowActions } from '../../components/RowActions';

// Announcements — the storefront popup (spec 2026-10-06 §5): ads, upcoming
// drops, news. Every visitor sees the live set once per MYT day as one swipe
// carousel; saving any change re-shows it at once (the storefront keys the
// dismissal on ids + updated_at). Writes are audited, so every save carries a
// reason.
export const config: RouteConfig = {
  label: 'Announcements',
  icon: BellAlert,
  rank: 26, // after Storefront (25)
};

const TITLE_MAX = 80;

interface Draft {
  id?: string;
  image_url: string;
  title: string;
  link_url: string;
  active: boolean;
  sort: string;
  startsAt: string;
  endsAt: string;
}

const blankDraft = (): Draft => ({
  image_url: '',
  title: '',
  link_url: '',
  active: true,
  sort: '0',
  startsAt: '',
  endsAt: '',
});

const draftFrom = (a: AdminAnnouncement): Draft => ({
  id: a.id,
  image_url: a.image_url,
  title: a.title ?? '',
  link_url: a.link_url ?? '',
  active: a.active,
  sort: String(a.sort),
  startsAt: a.starts_at ? toLocalInput(new Date(a.starts_at)) : '',
  endsAt: a.ends_at ? toLocalInput(new Date(a.ends_at)) : '',
});

// Mirrors the server rule (modules/packs/announcements.ts): an in-site /path
// (never `//` or `/\`, which a browser treats as off-origin) or an http(s)
// URL, with no whitespace, backslash or control character anywhere.
const linkOk = (v: string): boolean => {
  const t = v.trim();
  if (t === '') return true;
  if (
    t.length > 2048 ||
    /[\s\\]/.test(t) ||
    [...t].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  ) {
    return false;
  }
  return /^\/(?![/\\])/.test(t) || /^https?:\/\//i.test(t);
};

// Mirrors the server's ANNOUNCEMENT_SORT_MAX.
const SORT_MAX = 1_000_000;
const sortOk = (v: string): boolean => {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && Math.abs(n) <= SORT_MAX;
};

const dateLabel = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : '—';

const windowLabel = (a: AdminAnnouncement): string =>
  a.starts_at || a.ends_at
    ? `${dateLabel(a.starts_at)} → ${dateLabel(a.ends_at)}`
    : 'Always on';

// Same rule the store route applies (start inclusive, end exclusive).
const statusOf = (
  a: AdminAnnouncement,
  now: number,
): { label: string; color: 'green' | 'blue' | 'grey' | 'orange' } => {
  if (!a.active) return { label: 'Off', color: 'grey' };
  if (a.starts_at && new Date(a.starts_at).getTime() > now)
    return { label: 'Scheduled', color: 'blue' };
  if (a.ends_at && new Date(a.ends_at).getTime() <= now)
    return { label: 'Ended', color: 'orange' };
  return { label: 'Live', color: 'green' };
};

const Field = ({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <div className={`flex flex-col gap-y-1 ${className ?? ''}`}>
    <Label htmlFor={htmlFor} size="small" weight="plus">
      {label}
    </Label>
    {children}
    {hint && (
      <Text size="small" className="text-ui-fg-subtle">
        {hint}
      </Text>
    )}
  </div>
);

// Roughly what a phone visitor sees: the popup card centred over the dimmed
// page — the same 4:5 object-contain frame, caption and round close button
// the storefront renders (src/components/app-shell/AnnouncementPopup.tsx).
const PhonePreview = ({
  imageUrl,
  title,
}: {
  imageUrl: string;
  title: string;
}) => (
  <div
    aria-label="Phone preview"
    className="flex aspect-[9/19] w-[260px] shrink-0 items-center justify-center rounded-[2rem] border-[6px] border-neutral-800 bg-neutral-950 px-4"
  >
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
      <div className="flex aspect-[4/5] w-full items-center justify-center bg-black/40">
        {imageUrl ? (
          <img
            src={resolveImageUrl(imageUrl)}
            alt=""
            className="h-full w-full object-contain"
          />
        ) : (
          <Text size="small" className="px-4 text-center text-neutral-400">
            Upload an image to preview
          </Text>
        )}
      </div>
      {title.trim() && (
        <p className="px-3 py-2.5 text-center text-sm font-bold leading-snug text-white">
          {title.trim()}
        </p>
      )}
      <span className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full border border-white/20 bg-neutral-900/80 text-white">
        <XMark />
      </span>
    </div>
  </div>
);

function AnnouncementEditor({
  draft,
  onChange,
  onClose,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
}) {
  const save = useSaveAnnouncement();
  const upload = useUploadImage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState('');

  const scheduleValid = scheduleOk(draft);
  const linkValid = linkOk(draft.link_url);
  const sortValid = sortOk(draft.sort);
  const valid = Boolean(
    draft.image_url &&
    draft.title.trim().length <= TITLE_MAX &&
    linkValid &&
    sortValid &&
    scheduleValid &&
    reason.trim(),
  );

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Instant client-side gate; the server re-validates and is authoritative.
    const problem = await validateImageFile(file, 'announcement');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await upload.mutateAsync({ file, kind: 'announcement' });
      onChange({ ...draft, image_url: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = () => {
    if (!valid) return;
    save.mutate(
      {
        id: draft.id,
        image_url: draft.image_url,
        title: draft.title.trim() || null,
        link_url: draft.link_url.trim() || null,
        active: draft.active,
        sort: Number(draft.sort),
        starts_at: toIso(draft.startsAt),
        ends_at: toIso(draft.endsAt),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(
            draft.id ? 'Announcement updated.' : 'Announcement created.',
          );
          onClose();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <FocusModal open onOpenChange={(o) => !o && onClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center gap-x-2">
            <Button size="small" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="small"
              onClick={submit}
              isLoading={save.isPending}
              disabled={!valid || save.isPending || upload.isPending}
            >
              {draft.id ? 'Save changes' : 'Create announcement'}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="pc-admin flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[880px] flex-col gap-y-6">
            <FocusModal.Title asChild>
              <Heading level="h2">
                {draft.id ? 'Edit announcement' : 'New announcement'}
              </Heading>
            </FocusModal.Title>

            <div className="flex flex-wrap items-start gap-10">
              <div className="flex min-w-[320px] flex-1 flex-col gap-y-5">
                <Field
                  label="Image"
                  hint="Any shape — a 4:5 portrait (e.g. 1080×1350) fills the popup best. At least 400px wide; no animation."
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFile}
                  />
                  <div>
                    <Button
                      size="small"
                      variant="secondary"
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      isLoading={upload.isPending}
                    >
                      {draft.image_url ? 'Replace image…' : 'Upload image…'}
                    </Button>
                  </div>
                </Field>

                <Field
                  label="Caption"
                  htmlFor="ann-title"
                  hint={`Optional bold line under the image. ${draft.title.trim().length}/${TITLE_MAX}.`}
                >
                  <Input
                    id="ann-title"
                    value={draft.title}
                    maxLength={TITLE_MAX}
                    onChange={(e) =>
                      onChange({ ...draft, title: e.target.value })
                    }
                    placeholder="e.g. RM50 free credits for new users"
                  />
                </Field>

                <Field
                  label="Link"
                  htmlFor="ann-link"
                  hint="Optional. Tapping the image opens it: a site path like /slots/base-set, or a full https:// URL (opens in a new tab)."
                >
                  <Input
                    id="ann-link"
                    value={draft.link_url}
                    onChange={(e) =>
                      onChange({ ...draft, link_url: e.target.value })
                    }
                    placeholder="/slots/base-set"
                  />
                  {!linkValid && (
                    <Text size="small" className="text-ui-fg-error">
                      Use a path starting with / or an http(s):// URL.
                    </Text>
                  )}
                </Field>

                <div className="flex flex-wrap gap-4">
                  <Field
                    label="Order"
                    htmlFor="ann-sort"
                    hint="Low numbers first in the carousel."
                    className="w-40"
                  >
                    <Input
                      id="ann-sort"
                      type="number"
                      value={draft.sort}
                      onChange={(e) =>
                        onChange({ ...draft, sort: e.target.value })
                      }
                    />
                    {!sortValid && (
                      <Text size="small" className="text-ui-fg-error">
                        A whole number between -{SORT_MAX.toLocaleString()} and{' '}
                        {SORT_MAX.toLocaleString()}.
                      </Text>
                    )}
                  </Field>
                  <Field
                    label="Active"
                    hint={
                      draft.active
                        ? 'Shown while inside its schedule.'
                        : 'Hidden from the storefront.'
                    }
                    className="w-56"
                  >
                    <div className="flex h-8 items-center">
                      <Switch
                        checked={draft.active}
                        onCheckedChange={(active) =>
                          onChange({ ...draft, active })
                        }
                        aria-label="Active"
                      />
                    </div>
                  </Field>
                </div>

                <div className="flex flex-wrap items-start gap-4">
                  <Field label="Starts" htmlFor="ann-starts" className="w-56">
                    <Input
                      id="ann-starts"
                      type="datetime-local"
                      value={draft.startsAt}
                      onChange={(e) =>
                        onChange({ ...draft, startsAt: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Ends" htmlFor="ann-ends" className="w-56">
                    <Input
                      id="ann-ends"
                      type="datetime-local"
                      value={draft.endsAt}
                      onChange={(e) =>
                        onChange({ ...draft, endsAt: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <Text size="small" className="text-ui-fg-subtle -mt-3">
                  Schedule is optional — leave both blank to show it from now
                  until you switch it off.
                </Text>
                {!scheduleValid && (
                  <Text size="small" className="text-ui-fg-error">
                    The end must be after the start.
                  </Text>
                )}

                <Field
                  label="Reason"
                  htmlFor="ann-reason"
                  hint="Recorded against your admin account. Required."
                >
                  <Input
                    id="ann-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Promote the Base Set drop"
                  />
                </Field>
              </div>

              <div className="flex flex-col items-center gap-y-2">
                <PhonePreview imageUrl={draft.image_url} title={draft.title} />
                <Text size="small" className="text-ui-fg-subtle">
                  Phone preview
                </Text>
              </div>
            </div>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
}

const AnnouncementsPage = () => {
  // Status is "as of the last fetch" — dataUpdatedAt, not a Date.now() in
  // render (impure; the React compiler lint refuses it). The list refetches
  // after every save, so it is never staler than the operator's last action.
  const { data, isLoading, isError, dataUpdatedAt } = useAnnouncements();
  const save = useSaveAnnouncement();
  const remove = useDeleteAnnouncement();
  const [editing, setEditing] = useState<Draft | null>(null);

  // The row switch is the common on/off case, applied without the form. Same
  // audited POST as a save, with a fixed reason.
  const toggleActive = (a: AdminAnnouncement) =>
    save.mutate(
      {
        id: a.id,
        image_url: a.image_url,
        title: a.title,
        link_url: a.link_url,
        active: !a.active,
        sort: a.sort,
        starts_at: a.starts_at,
        ends_at: a.ends_at,
        reason: a.active
          ? 'Switched off from the list'
          : 'Switched on from the list',
      },
      {
        onSuccess: () =>
          toast.success(a.active ? 'Announcement off.' : 'Announcement on.'),
        onError: (e) => toast.error(e.message),
      },
    );

  const destroy = (a: AdminAnnouncement) =>
    remove.mutate(
      { id: a.id, reason: 'Deleted from the announcements list' },
      {
        onSuccess: () => toast.success('Announcement deleted.'),
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <Container className="p-0">
      <div className="flex items-start justify-between px-6 py-4">
        <div>
          <Heading level="h2">Announcements</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            The storefront popup — ads, upcoming drops, news. Every visitor sees
            the live ones once a day (MYT) as a swipe carousel; any save shows
            it again straight away.
          </Text>
        </div>
        <Button size="small" onClick={() => setEditing(blankDraft())}>
          New announcement
        </Button>
      </div>

      {editing && (
        <AnnouncementEditor
          draft={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
        />
      )}

      {isError ? (
        <Text size="small" className="text-ui-fg-error px-6 pb-6">
          Failed to load announcements.
        </Text>
      ) : isLoading || !data ? (
        <div className="px-6 pb-6">
          <LoadingSkeleton rows={3} />
        </div>
      ) : data.length === 0 ? (
        <Text size="small" className="text-ui-fg-muted px-6 py-4">
          No announcements yet.
        </Text>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Image</Table.HeaderCell>
              <Table.HeaderCell>Caption</Table.HeaderCell>
              <Table.HeaderCell>Link</Table.HeaderCell>
              <Table.HeaderCell>Runs</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Active</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((a) => {
              const status = statusOf(a, dataUpdatedAt);
              const subject = a.title ?? 'Untitled announcement';
              return (
                <Table.Row key={a.id}>
                  <Table.Cell>
                    <div className="flex h-14 w-11 items-center justify-center overflow-hidden rounded-md bg-neutral-900">
                      <img
                        src={resolveImageUrl(a.image_url)}
                        alt=""
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center gap-x-2">
                      <Text size="small">{a.title ?? '—'}</Text>
                      <Text
                        size="small"
                        className="text-ui-fg-muted tabular-nums"
                      >
                        #{a.sort}
                      </Text>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle max-w-[220px] truncate">
                    {a.link_url ?? '—'}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                    {windowLabel(a)}
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={status.color}>
                      {status.label}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>
                    <Switch
                      checked={a.active}
                      disabled={save.isPending}
                      onCheckedChange={() => toggleActive(a)}
                      aria-label={`${subject} active`}
                    />
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    <RowActions
                      subject={subject}
                      actions={[
                        {
                          label: 'Edit',
                          onSelect: () => setEditing(draftFrom(a)),
                        },
                        {
                          label: 'Delete',
                          danger: true,
                          onSelect: () => destroy(a),
                          confirm: {
                            title: 'Delete this announcement?',
                            description:
                              'It disappears from the storefront popup. To pause it instead, switch Active off.',
                          },
                        },
                      ]}
                    />
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}
    </Container>
  );
};

export default AnnouncementsPage;
