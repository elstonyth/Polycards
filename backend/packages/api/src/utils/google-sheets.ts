import { createSign } from 'node:crypto';

// Google Sheets over plain fetch, signed in as a service account. The Google
// client library is a large dependency for one token exchange and two calls.
// Flow: developers.google.com/identity/protocols/oauth2/service-account (HTTP/REST).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 20_000;

export type ServiceAccount = { client_email: string; private_key: string };

// A cell as the API reads and writes it (CellData.userEnteredValue).
export type CellValue = {
  stringValue?: string;
  numberValue?: number;
  boolValue?: boolean;
  formulaValue?: string;
};
export type Cell = { userEnteredValue?: CellValue };
export type Grid = Cell[][];

/** A text cell, written as stringValue so "=..." stays text, never a formula. */
export const textCell = (v: string | null | undefined): Cell =>
  v ? { userEnteredValue: { stringValue: v } } : {};
export const cellText = (c: Cell | undefined): string | undefined =>
  c?.userEnteredValue?.stringValue;

const cellKey = (c: Cell | undefined): string =>
  JSON.stringify(c?.userEnteredValue ?? {});

/** True when two cells hold the same value (an empty cell = a missing one). */
export const sameCell = (a: Cell | undefined, b: Cell | undefined): boolean =>
  cellKey(a) === cellKey(b);

/** True when two rows agree in their first `columns` cells. */
export const sameRow = (
  a: Cell[] | undefined,
  b: Cell[] | undefined,
  columns: number,
): boolean =>
  Array.from({ length: columns }, (_, j) => sameCell(a?.[j], b?.[j])).every(
    Boolean,
  );

/** Rows in use: the API leaves out empty trailing rows, and so does this. */
export function usedRows(g: Grid, columns: number): number {
  let n = g.length;
  while (n > 0 && g[n - 1].slice(0, columns).every((c) => cellKey(c) === '{}'))
    n--;
  return n;
}

/** True when the sheet already shows `want` in its first `columns` columns.
 *  Empty trailing rows and cells (the API leaves them out) don't count. */
export function sameGrid(want: Grid, have: Grid, columns: number): boolean {
  if (usedRows(want, columns) !== usedRows(have, columns)) return false;
  return want.every((row, i) => sameRow(row, have[i], columns));
}

/** The key in GOOGLE_SERVICE_ACCOUNT_JSON: the JSON key file Google hands out,
 *  as is or base64-encoded. Null when unset; throws when it can't be read. */
export function serviceAccountFromEnv(
  raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
): ServiceAccount | null {
  const text = raw?.trim();
  if (!text) return null;
  let json: Partial<ServiceAccount>;
  try {
    json = JSON.parse(
      text.startsWith('{')
        ? text
        : Buffer.from(text, 'base64').toString('utf8'),
    ) as Partial<ServiceAccount>;
  } catch {
    // A fixed message: the parser's own echoes part of the key.
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not a JSON key file');
  }
  if (
    typeof json.client_email !== 'string' ||
    typeof json.private_key !== 'string'
  ) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON has no client_email or private_key',
    );
  }
  return { client_email: json.client_email, private_key: json.private_key };
}

const b64url = (s: string | Buffer): string =>
  Buffer.from(s).toString('base64url');

/** The RS256 assertion Google swaps for an access token. An hour is the most it allows. */
export function signedJwt(sa: ServiceAccount, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256')
    .update(`${head}.${claims}`)
    .sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

let cached: { email: string; token: string; until: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cached && cached.email === sa.client_email && cached.until > now) {
    return cached.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt(sa, Math.floor(now / 1000)),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new Error(
      `Google sign-in ${res.status}: ${body.error_description ?? body.error ?? 'no access_token'}`,
    );
  }
  // Renewed a minute early, so no call goes out on a token about to lapse.
  cached = {
    email: sa.client_email,
    token: body.access_token,
    until: now + (Number(body.expires_in) || 3600) * 1000 - 60_000,
  };
  return cached.token;
}

export class SheetsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One Sheets API call: GET `path` under /v4/spreadsheets/, or POST `body` to it. */
export async function sheetsCall<T>(
  sa: ServiceAccount,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${SHEETS_API}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${await accessToken(sa)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!res.ok) {
    if (res.status === 401) cached = null; // revoked or expired early
    throw new SheetsError(
      res.status,
      `Google Sheets ${res.status}: ${json.error?.message ?? res.statusText}`,
    );
  }
  return json as T;
}
