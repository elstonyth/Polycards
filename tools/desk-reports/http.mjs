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
      headers: { 'x-report-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ReportError(
      'Could not reach the Polycards backend. Try again in a minute.',
    );
  }
  const body = await res.json().catch(() => null);
  if (res.ok) return body;
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
