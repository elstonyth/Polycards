// Tiny server-side PriceCharting client shared by the /admin/pricecharting/*
// proxy routes. The API is a paid product authenticated by a 40-char token
// (https://www.pricecharting.com/api-documentation): the token is read from
// PRICECHARTING_API_TOKEN and appended as the `t` query param — it must NEVER be
// exposed to the browser, which is why the admin UI talks to these proxies.
// Upstream prices are integer PENNIES; conversion to USD happens in the routes.

const BASE_URL = 'https://www.pricecharting.com';
const TIMEOUT_MS = 10_000;

export const PC_TOKEN_MISSING =
  'PriceCharting is not configured: set PRICECHARTING_API_TOKEN in the backend .env ' +
  '(requires a paid PriceCharting subscription) or enter the market value manually.';

// `cause` marks an error that is about the feed, not the card or query asked
// for: "auth" = the token is expired/revoked (every request will fail until it
// is renewed), "unavailable" = timeout, outage, rate limit or any error reply we
// do not recognise (unknown errors default to feed-level). No cause = card-level,
// only for a 404 or a "no such product" / "not found" reply about this request.
export type PcErrorCause = 'auth' | 'unavailable';

export type PcResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'no-token' }
  | { kind: 'error'; message: string; cause?: PcErrorCause };

export async function pcFetch<
  T extends { status: string; 'error-message'?: string },
>(path: string, params: Record<string, string>): Promise<PcResult<T>> {
  const token = process.env.PRICECHARTING_API_TOKEN;
  if (!token) return { kind: 'no-token' };

  const url = new URL(path, BASE_URL);
  url.searchParams.set('t', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return {
      kind: 'error',
      message: 'PriceCharting did not respond — try again.',
      cause: 'unavailable',
    };
  }

  // Status first: an auth or outage reply may not carry a JSON body.
  let data: T | undefined;
  try {
    data = (await resp.json()) as T;
  } catch {
    data = undefined;
  }
  const upstreamMessage = data?.['error-message'];

  if (resp.status >= 500 || resp.status === 429) {
    return {
      kind: 'error',
      message: upstreamMessage ?? `PriceCharting error (HTTP ${resp.status}).`,
      cause: 'unavailable',
    };
  }
  // 410 is what PriceCharting sent for "Access token has expired" (2026-10-19);
  // a 410 with another message may be a removed product, and a bare 401/403
  // may be an edge/WAF block, so those need a token message.
  const tokenMessage = /\btoken\b/i.test(upstreamMessage ?? '');
  if (
    (resp.status === 410 && (tokenMessage || !upstreamMessage)) ||
    (tokenMessage &&
      (resp.status === 401 ||
        resp.status === 403 ||
        data?.status !== 'success'))
  ) {
    return {
      kind: 'error',
      message:
        upstreamMessage ??
        `PriceCharting rejected the API token (HTTP ${resp.status}).`,
      cause: 'auth',
    };
  }
  if (resp.status === 404) {
    return {
      kind: 'error',
      message: upstreamMessage ?? 'PriceCharting error (HTTP 404).',
    };
  }
  if (!data) {
    return {
      kind: 'error',
      message: `PriceCharting returned an unreadable response (HTTP ${resp.status}).`,
      cause: 'unavailable',
    };
  }
  if (!resp.ok || data.status !== 'success') {
    return {
      kind: 'error',
      message: upstreamMessage ?? `PriceCharting error (HTTP ${resp.status}).`,
      ...(/no such product|not found/i.test(upstreamMessage ?? '')
        ? {}
        : { cause: 'unavailable' as const }),
    };
  }
  return { kind: 'ok', data };
}
