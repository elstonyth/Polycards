import { unstable_isUnrecognizedActionError } from 'next/navigation';

// A tab left open across a deploy runs the previous bundle against the new
// server: its next lazily-loaded chunk can 404 (the deploy deleted it) and its
// Server Action IDs can be unknown. Only a full page load fixes either — an
// error boundary's reset() just retries the same dead request.
export function isVersionSkewError(error: unknown): boolean {
  if (unstable_isUnrecognizedActionError(error)) return true;
  return (
    error instanceof Error &&
    (error.name === 'ChunkLoadError' ||
      /^Loading chunk \S+ failed/.test(error.message))
  );
}

const RELOADED_AT = 'polycards:skew-reload';
// ponytail: one reload per 30s per tab. A skew the reload can't cure (an edge
// still serving the old HTML) falls through to the boundary's own UI instead
// of looping; a smarter backoff only if that ever shows up in Sentry.
const WINDOW_MS = 30_000;

/** Reloads the page for a version-skew error, at most once per window.
 *  Returns true when it reloaded. */
export function reloadForVersionSkew(
  error: unknown,
  reload: () => void = () => window.location.reload(),
): boolean {
  if (!isVersionSkewError(error)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT));
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // No storage means no loop guard — leave it to the boundary's UI.
    return false;
  }
  reload();
  return true;
}
