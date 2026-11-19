/**
 * Pack stage crash guard (plan section 5, "Crash loop"). One sessionStorage
 * key:
 * - `'boot'` is written just before the WebGL renderer is created and removed
 *   after 5 s of stable running or on `pagehide`. iOS kills a tab that runs
 *   out of GPU memory without firing `pagehide`, so a `'boot'` found at the
 *   next load means the last attempt died.
 * - `'crashed'` is written on context loss or a runtime failure and is never
 *   cleared: flat for the rest of the session.
 * Any value found at boot means flat for the session.
 *
 * Storage that is missing or throws reads as "no flag" and every write is a
 * no-op, so a blocked sessionStorage never breaks the page (the 3D attempt
 * then simply has no crash protection).
 *
 * Server-safe: nothing runs at import time, so `stage-loader-script.ts` can
 * import `STAGE_CRASH_KEY`.
 */

export const STAGE_CRASH_KEY = 'polycards:pack-stage-3d';
export const STAGE_STABLE_MS = 5000;

export type CrashFlag = 'boot' | 'crashed';
export type CrashStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): CrashStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** True when a flag is present: the last 3D attempt died, or 3D crashed. */
export function readCrashFlag(
  storage: CrashStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STAGE_CRASH_KEY) !== null;
  } catch {
    return false;
  }
}

/** Write `'boot'` immediately before creating the renderer. */
export function markBooting(
  storage: CrashStorage | null = defaultStorage(),
): void {
  write(storage, 'boot');
}

/** Context loss or runtime failure: flat for the session. */
export function markCrashed(
  storage: CrashStorage | null = defaultStorage(),
): void {
  write(storage, 'crashed');
}

/** Remove a `'boot'` flag (stable for 5 s, or `pagehide`). Never clears `'crashed'`. */
export function clearBooting(
  storage: CrashStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (storage.getItem(STAGE_CRASH_KEY) === 'boot')
      storage.removeItem(STAGE_CRASH_KEY);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

function write(storage: CrashStorage | null, value: CrashFlag): void {
  if (!storage) return;
  try {
    storage.setItem(STAGE_CRASH_KEY, value);
  } catch {
    // Storage full or blocked: do nothing.
  }
}

export interface BootGuard {
  /** Clear the boot flag now (also cancels the timer and listener). */
  settle(): void;
  /** Cancel the timer and listener without touching the flag. */
  cancel(): void;
}

/**
 * Arm the guard right before renderer creation: writes `'boot'`, clears it
 * after `stableMs` or on `pagehide`, whichever is first.
 */
export function armBootGuard(
  opts: {
    storage?: CrashStorage | null;
    target?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
    stableMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
  } = {},
): BootGuard {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const target =
    opts.target === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : opts.target;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ??
    ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  markBooting(storage);
  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    clearTimer(timer);
    target?.removeEventListener('pagehide', onHide);
  };
  const settle = () => {
    cancel();
    clearBooting(storage);
  };
  const onHide = () => settle();
  const timer = setTimer(settle, opts.stableMs ?? STAGE_STABLE_MS);
  target?.addEventListener('pagehide', onHide);
  return { settle, cancel };
}
