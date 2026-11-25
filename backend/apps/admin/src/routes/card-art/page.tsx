import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Text,
  toast,
  usePrompt,
} from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  deleteCardArt,
  getCardArtMissing,
  refreshCardList,
  listCardArt,
  saveCardArt,
  uploadImage,
} from '../../lib/admin-rest';
import { artCodeFromFilename } from '../../lib/card-art';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'pcNav.cardArt',
  translationNs: 'translation',
  rank: 3,
  nested: '/packs',
};

const PAGE_SIZE = 60;
const WORKERS = 4; // parallel uploads
const SAVE_BATCH = 50; // rows per POST /admin/card-art (route cap 200)

type Problem = { name: string; message: string };
type Run = {
  total: number;
  done: number;
  saved: number;
  problems: Problem[];
  running: boolean;
};

// Card art — the clean, stamp-free image of every card printing. Files are
// named by card code; a new set is one folder upload. The PriceCharting
// import attaches the matching image (lib/card-art.ts pickCardArt).
// "Missing": the stored card list (every One Piece printing, re-read from
// Limitless by the refresh button) minus the uploaded art. Keyed under
// 'card-art' so uploads and deletes refresh it too.
const MissingArt = () => {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const { data, isError } = useQuery({
    queryKey: ['card-art', 'missing'],
    queryFn: getCardArtMissing,
  });
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshCardList();
      toast.success(
        `Card list refreshed: ${r.count} printings` +
          (r.previous ? ` (was ${r.previous}).` : '.'),
      );
      qc.invalidateQueries({ queryKey: ['card-art'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section
      aria-labelledby="card-art-missing"
      className="border-ui-border-base flex flex-col gap-y-2 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Text size="small" weight="plus" id="card-art-missing">
            Missing
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            {isError
              ? 'Could not load the missing list.'
              : !data
                ? 'Loading…'
                : data.total === 0
                  ? 'No card list yet. Refresh it to see which cards have no clean art.'
                  : `${data.missing} of ${data.total} printings have no clean art` +
                    (data.fetched_at
                      ? ` · card list from ${new Date(data.fetched_at).toLocaleDateString()}`
                      : '')}
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          isLoading={refreshing}
          onClick={() => void refresh()}
        >
          Refresh card list
        </Button>
      </div>
      {data && data.sets.length > 0 && (
        <div className="flex flex-col gap-1">
          {data.sets.map((s) => (
            <details key={s.set} className="text-sm">
              <summary className="cursor-pointer">
                {s.set} · {s.missing} of {s.total} missing
              </summary>
              <ul className="text-ui-fg-subtle mt-1 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 text-xs">
                {s.cards.map((c) => (
                  <li key={c.code}>
                    {c.code} · {c.name}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
};

const CardArtPage = () => {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const prompt = usePrompt();

  const { data, isError } = useQuery({
    queryKey: ['card-art', q, page],
    queryFn: () => listCardArt({ q, page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const upload = async (list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const problems: Problem[] = [];
    const queue: { file: File; code: string }[] = [];
    for (const file of files) {
      const code = artCodeFromFilename(file.name);
      // two files for one code in one run: parallel uploads would let either
      // win silently, so the first is kept and the rest are reported
      if (code && queue.some((q) => q.code === code))
        problems.push({
          name: file.name,
          message: `Another file in this upload is also ${code}`,
        });
      else if (code) queue.push({ file, code });
      else
        problems.push({
          name: file.name,
          message: 'Name does not start with a card code',
        });
    }
    const state: Run = {
      total: files.length,
      done: problems.length,
      saved: 0,
      problems,
      running: true,
    };
    setRun({ ...state });
    let pending: { code: string; image_url: string }[] = [];
    const flush = async () => {
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      try {
        state.saved += (await saveCardArt(batch)).saved;
      } catch (e) {
        for (const b of batch)
          problems.push({ name: b.code, message: (e as Error).message });
      }
    };
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const { file, code } = queue[next++];
        try {
          const bad = await validateImageFile(file, 'card');
          if (bad) throw new Error(bad);
          pending.push({ code, image_url: await uploadImage(file, 'card') });
          if (pending.length >= SAVE_BATCH) await flush();
        } catch (e) {
          problems.push({ name: file.name, message: (e as Error).message });
        }
        state.done++;
        setRun({ ...state, problems: [...problems] });
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    await flush();
    setRun({ ...state, problems: [...problems], running: false });
    qc.invalidateQueries({ queryKey: ['card-art'] });
    if (problems.length === 0)
      toast.success(`${state.saved} card images saved.`);
    else
      toast.warning(
        `${state.saved} card images saved, ${problems.length} not saved.`,
      );
  };

  const remove = async (code: string) => {
    const ok = await prompt({
      title: `Delete ${code}?`,
      description:
        'Imports stop attaching this image. Cards already saved keep theirs.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    try {
      await deleteCardArt(code);
      qc.invalidateQueries({ queryKey: ['card-art'] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Container className="flex flex-col gap-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-2xl flex-col gap-y-1">
          <Heading level="h2">Card art</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Clean, stamp-free card images, one per printing. Name each file by
            its card code: OP05-119.png for the base art, OP05-119_p1.png for
            the first alternate art. Uploading a code again replaces it. The Add
            from PriceCharting import attaches these automatically.
          </Text>
        </div>
        <div className="flex gap-2">
          <input
            ref={filesRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={folderRef}
            type="file"
            className="hidden"
            // a whole set folder at once; every image file inside is read
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            size="small"
            variant="secondary"
            disabled={run?.running}
            onClick={() => filesRef.current?.click()}
          >
            Upload images
          </Button>
          <Button
            size="small"
            disabled={run?.running}
            onClick={() => folderRef.current?.click()}
          >
            Upload folder
          </Button>
        </div>
      </div>

      {run && (
        <div
          className="bg-ui-bg-subtle flex flex-col gap-y-2 rounded-lg p-4"
          role="status"
        >
          <Text size="small" weight="plus">
            {run.running ? 'Uploading' : 'Upload finished'}: {run.done} of{' '}
            {run.total} files · {run.saved} saved
            {run.problems.length > 0 && ` · ${run.problems.length} not saved`}
          </Text>
          <progress
            className="h-2 w-full"
            max={run.total}
            value={run.done}
            aria-label="Upload progress"
          />
          {!run.running && run.problems.length > 0 && (
            <ul className="text-ui-fg-error max-h-40 overflow-auto text-xs">
              {run.problems.map((p, i) => (
                <li key={i}>
                  {p.name}: {p.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <MissingArt />

      {data && data.sets.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Sets">
          {data.sets.map((s) => (
            <button
              key={s.set}
              type="button"
              onClick={() => {
                setQ(q === `${s.set}-` ? '' : `${s.set}-`);
                setPage(0);
              }}
              aria-pressed={q === `${s.set}-`}
            >
              <Badge size="2xsmall" color={q === `${s.set}-` ? 'blue' : 'grey'}>
                {s.set} · {s.count}
              </Badge>
            </button>
          ))}
        </div>
      )}

      <Input
        type="search"
        placeholder="Search by code (OP05, OP05-119)…"
        aria-label="Search card art by code"
        value={q}
        onChange={(e) => {
          setQ(e.target.value.trim());
          setPage(0);
        }}
      />

      {isError ? (
        <Text className="text-ui-fg-error">Could not load the card art.</Text>
      ) : !data ? (
        <LoadingSkeleton />
      ) : data.card_art.length === 0 ? (
        <Text className="text-ui-fg-subtle">
          {q ? 'No card art matches that code.' : 'No card art uploaded yet.'}
        </Text>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
            {data.card_art.map((a) => (
              <figure key={a.code} className="flex flex-col gap-1">
                <img
                  src={resolveImageUrl(a.image_url)}
                  alt={a.code}
                  loading="lazy"
                  className="border-ui-border-base aspect-[5/7] w-full rounded border object-contain"
                />
                <figcaption className="flex items-center justify-between gap-1">
                  <Text size="xsmall">{a.code}</Text>
                  <Button
                    size="small"
                    variant="transparent"
                    aria-label={`Delete ${a.code}`}
                    onClick={() => void remove(a.code)}
                  >
                    ×
                  </Button>
                </figcaption>
              </figure>
            ))}
          </div>
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.card_art.length}
            total={data.total}
          />
        </>
      )}
    </Container>
  );
};

export default CardArtPage;
