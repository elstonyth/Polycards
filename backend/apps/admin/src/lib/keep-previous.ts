import type { Query } from '@tanstack/react-query';

/**
 * keepPreviousData, but only for a page turn: the previous result is kept
 * while the next page loads when the old key and the new one differ ONLY in
 * the page segment, which sits just before `filterFrom` (the first filter
 * segment). A filter or sort change, or another customer, gets no
 * placeholder, so the old filter's rows never show under the new one.
 */
export const keepPreviousWhenSame =
  (key: readonly unknown[], filterFrom: number) =>
  <T>(
    previous: T | undefined,
    previousQuery: Pick<Query, 'queryKey'> | undefined,
  ): T | undefined => {
    const old = previousQuery?.queryKey;
    if (previous === undefined || !old || old.length !== key.length) {
      return undefined;
    }
    const page = filterFrom - 1;
    return key.every((seg, i) => i === page || seg === old[i])
      ? previous
      : undefined;
  };
