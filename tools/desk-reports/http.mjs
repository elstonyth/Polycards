// One GET against the backend's report routes. The key travels only in a
// header; every failure becomes a sentence the desk bot can pass to staff,
// and none of them contains the key.
export class ReportError extends Error {}

export async function getReport({
  baseUrl,
  desk,
  key,
  path,
  params = {},
  fetchImpl = fetch,
  timeoutMs = 15_000,
  as = 'json',
}) {
  if (!key || key.startsWith('${')) {
    throw new ReportError(
      'The report key is not configured on this PC, so live data is unavailable. Tell the admin.',
    );
  }
  const url = new URL(`/reports/${desk}/${path}`, baseUrl);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '')
      url.searchParams.set(name, String(value));
  }
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        'x-report-key': key,
        accept: as === 'image' ? 'image/*' : 'application/json',
      },
      // fetch strips Authorization and Cookie on a cross-origin redirect but
      // replays custom headers such as x-report-key. Refuse to follow one.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ReportError(
      'Could not reach the Polycards backend. Try again in a minute.',
    );
  }
  if (as === 'image' && res.ok) {
    // A poster: the bytes go back as base64 for an MCP image block.
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? '';
    const bytes = await res.arrayBuffer().catch(() => null);
    if (mimeType.startsWith('image/') && bytes?.byteLength)
      return {
        mimeType,
        data: Buffer.from(bytes).toString('base64'),
        // Podium ranks drawn as placeholder tiles, if any.
        missingArt: res.headers.get('x-poster-missing-art') ?? '',
        // The exact live figure behind a brand poster, if it shows one.
        figure: res.headers.get('x-poster-figure') ?? '',
        // '0' when a goal is drawn as the goal, '1' once the data reached it.
        goalReached: res.headers.get('x-poster-goal-reached') ?? '',
        // The VIP levels an achievements poster drew, like '10,20,30'.
        levels: res.headers.get('x-poster-levels') ?? '',
        // Levels left off because their prize no longer exists.
        skipped: res.headers.get('x-poster-skipped') ?? '',
      };
    throw new ReportError(
      'The backend sent an unreadable image. Try again in a minute.',
    );
  }
  const body = await res.json().catch(() => null);
  if (res.ok) {
    // A 2xx that is not a JSON object (an HTML page, an empty or cut-off
    // body) is a failure, never a blank report.
    if (body !== null && typeof body === 'object') return body;
    throw new ReportError(
      'The backend sent an unreadable report. Try again in a minute.',
    );
  }
  if (res.status === 400 || res.status === 404) {
    throw new ReportError(
      body?.message ?? `The backend rejected the request (${res.status}).`,
    );
  }
  if (res.status === 401 || res.status === 503) {
    throw new ReportError(
      'Live reports are not set up for this desk yet (the backend refused the key). Tell the admin.',
    );
  }
  if (res.status === 429)
    throw new ReportError(
      'Too many report requests. Wait a minute, then try again.',
    );
  throw new ReportError(`The backend failed (${res.status}). Try again later.`);
}
