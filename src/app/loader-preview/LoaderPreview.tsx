'use client';

import { useEffect, useState } from 'react';
import { BrandLoader } from '@/components/loader/BrandLoader';

export type ReadyMode = 'now' | '3s' | 'never';

const READY_LABELS: Record<ReadyMode, string> = {
  now: 'Immediately',
  '3s': 'After 3 s',
  never: 'Never',
};

export function LoaderPreview({
  pinAt,
  initialReadyMode,
}: {
  pinAt?: number;
  initialReadyMode: ReadyMode;
}) {
  const [run, setRun] = useState(0);
  const [readyMode, setReadyMode] = useState<ReadyMode>(initialReadyMode);
  const [done, setDone] = useState(false);

  const replay = () => {
    setDone(false);
    setRun((n) => n + 1);
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-neutral-900 px-4 text-white">
      {!done && (
        <PreviewRun
          key={`${run}-${readyMode}`}
          readyMode={readyMode}
          pinAt={pinAt}
          onDone={() => setDone(true)}
        />
      )}
      <h1 className="text-lg font-semibold">Brand loader preview</h1>
      <p
        className="text-sm text-neutral-400"
        data-loader-done={done ? 'yes' : 'no'}
      >
        {done ? 'Loader finished.' : 'Loader running.'}
      </p>
      <fieldset className="flex flex-wrap items-center justify-center gap-3 text-sm">
        <legend className="mb-2 w-full text-center text-neutral-400">
          Ready turns true
        </legend>
        {(Object.keys(READY_LABELS) as ReadyMode[]).map((mode) => (
          <label key={mode} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ready-mode"
              value={mode}
              checked={readyMode === mode}
              onChange={() => {
                setReadyMode(mode);
                setDone(false);
              }}
            />
            {READY_LABELS[mode]}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        onClick={replay}
        className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-neutral-950"
      >
        Replay
      </button>
    </main>
  );
}

function PreviewRun({
  readyMode,
  pinAt,
  onDone,
}: {
  readyMode: ReadyMode;
  pinAt?: number;
  onDone: () => void;
}) {
  const [ready, setReady] = useState(readyMode === 'now');
  useEffect(() => {
    if (readyMode !== '3s') return;
    const id = window.setTimeout(() => setReady(true), 3000);
    return () => window.clearTimeout(id);
  }, [readyMode]);
  return <BrandLoader ready={ready} pinAt={pinAt} onDone={onDone} />;
}
