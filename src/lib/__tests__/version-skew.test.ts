// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { isVersionSkewError, reloadForVersionSkew } from '../version-skew';

// A tab left open across a deploy runs the old bundle against the new server:
// its next lazy chunk 404s (ChunkLoadError) and its action IDs are unknown
// (UnrecognizedActionError). Prod 2026-09-23: /me showed "We couldn't load this
// page" and "Try again" (reset()) re-requested the same deleted chunk forever.
const chunkError = () =>
  Object.assign(
    new Error(
      'Loading chunk 4315 failed.\n(error: https://polycards.gg/_next/static/chunks/4315-1240c0d2320b7277.js)',
    ),
    { name: 'ChunkLoadError' },
  );

describe('isVersionSkewError', () => {
  it('recognises a deleted chunk and an unknown server action', () => {
    expect(isVersionSkewError(chunkError())).toBe(true);
    expect(
      isVersionSkewError(
        new UnrecognizedActionError('Server Action not found'),
      ),
    ).toBe(true);
  });

  it('leaves every other failure to the normal error UI', () => {
    expect(isVersionSkewError(new Error('Profile not found'))).toBe(false);
    expect(isVersionSkewError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isVersionSkewError('Loading chunk 1 failed.')).toBe(false);
    expect(isVersionSkewError(null)).toBe(false);
  });
});

describe('reloadForVersionSkew', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it('reloads for a skew error, but only once per window so it cannot loop', () => {
    const reload = vi.fn();
    expect(reloadForVersionSkew(chunkError(), reload)).toBe(true);
    expect(reloadForVersionSkew(chunkError(), reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the window has passed', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    reloadForVersionSkew(chunkError(), reload);
    vi.advanceTimersByTime(31_000);
    expect(reloadForVersionSkew(chunkError(), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads for an ordinary error', () => {
    const reload = vi.fn();
    expect(reloadForVersionSkew(new Error('boom'), reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
