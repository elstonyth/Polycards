'use server';

/**
 * Lucky Draw server actions (spec 2026-10-24 §5, §9). Same auth discipline as
 * the task hub actions: the httpOnly JWT is read server-side by the Store
 * port and sent as an explicit Bearer. Reads answer null on any failure (the
 * page renders its empty or unavailable state); the one write answers a
 * result object, never an exception.
 */
import { store, type Failure } from '@/lib/store';
import {
  LuckyDrawBalanceSchema,
  LuckyDrawEnterSchema,
  LuckyDrawMineSchema,
  LuckyDrawPageSchema,
  LuckyDrawResultDetailSchema,
  LuckyDrawResultsSchema,
  LuckyDrawStatusSchema,
  type LuckyDrawMine,
  type LuckyDrawPage,
  type LuckyDrawResultDetail,
  type LuckyDrawResults,
} from '@/lib/data/schemas';

/** No cookie at all: the call never left (`status` is undefined). */
const loggedOut = (f: Failure): string | null =>
  f.kind === 'unauthenticated' && f.status === undefined
    ? 'Please log in first.'
    : null;

/** Is a Lucky Draw on? Needs no sign-in (the Games sheet asks for visitors
 *  too); null when the backend can't say. */
export async function getLuckyDrawLive(): Promise<boolean | null> {
  const r = await store.get('/store/lucky-draw-status', LuckyDrawStatusSchema, {
    auth: 'none',
  });
  return r.ok ? r.data.live : null;
}

export async function getLuckyDraw(): Promise<LuckyDrawPage | null> {
  const r = await store.get('/store/lucky-draw', LuckyDrawPageSchema);
  return r.ok ? r.data : null;
}

export type EnterLuckyDrawResult =
  | {
      ok: true;
      entered: true;
      /** Undefined only when the accepted response drifted: re-read the page. */
      balance: number | undefined;
      myTickets: number | undefined;
    }
  | { ok: true; entered: false; reason: string }
  | { ok: false; error: string };

export async function enterLuckyDraw(
  prizeId: string,
  tickets: number,
): Promise<EnterLuckyDrawResult> {
  const r = await store.post(
    `/store/lucky-draw/prizes/${encodeURIComponent(prizeId)}/enter`,
    LuckyDrawEnterSchema,
    { tickets },
  );
  if (!r.ok) {
    // Only a 4xx is a refusal before anything was spent. A 5xx, a timeout or
    // a 2xx we could not read may be an accepted entry: never invite a second
    // tap that would spend the tickets again.
    const refused = r.status !== undefined && r.status >= 400 && r.status < 500;
    const error =
      loggedOut(r) ??
      (!refused
        ? 'Something went wrong — refresh to see your tickets.'
        : r.kind === 'rate_limited'
          ? 'Too many tries — wait a moment and try again.'
          : r.status === 400
            ? 'Choose a whole number of tickets you have.'
            : 'Could not enter. Please try again.');
    return { ok: false, error };
  }
  return r.data.entered
    ? {
        ok: true,
        entered: true,
        balance: r.data.balance,
        myTickets: r.data.myTickets,
      }
    : { ok: true, entered: false, reason: r.data.reason };
}

export async function getLuckyDrawResults(
  before?: string,
): Promise<LuckyDrawResults | null> {
  const r = await store.get(
    '/store/lucky-draw/results',
    LuckyDrawResultsSchema,
    before ? { query: { before } } : undefined,
  );
  return r.ok ? r.data : null;
}

/** One drawn prize with its entry list; null until it is drawn (a 404). */
export async function getLuckyDrawResult(
  prizeId: string,
): Promise<LuckyDrawResultDetail | null> {
  const r = await store.get(
    `/store/lucky-draw/results/${encodeURIComponent(prizeId)}`,
    LuckyDrawResultDetailSchema,
  );
  return r.ok ? r.data : null;
}

export async function getMyLuckyDraw(): Promise<LuckyDrawMine | null> {
  const r = await store.get('/store/lucky-draw/me', LuckyDrawMineSchema);
  return r.ok ? r.data : null;
}

/** The vault's tickets row; null when unreadable (the row hides). */
export async function getTicketBalance(): Promise<number | null> {
  const r = await store.get(
    '/store/lucky-draw/balance',
    LuckyDrawBalanceSchema,
  );
  return r.ok ? r.data.balance : null;
}
