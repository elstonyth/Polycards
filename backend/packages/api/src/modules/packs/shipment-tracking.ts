// Carrier tracking for shipped delivery orders (2026-10-30). Parcels are
// dropped at the counter, so there is no shipper account and no API key:
// every carrier is read through the same public endpoint its own tracking
// page uses (for DHL eCommerce that is the page itself, which has no JSON).
// They are undocumented, so every reader here fails soft — a non-200, a
// timeout or an unexpected shape throws, and the caller skips that order for
// this run instead of guessing.
//
// Which carrier is decided by the tracking number alone, never by the
// address: SG parcels go out with Ninja Van's NVMY… numbers too, and West
// Malaysia sometimes goes by Pos Laju when a Ninja Van branch is closed.

export type Carrier = 'ninjavan' | 'poslaju' | 'dhl_ecommerce';

export type TrackingState =
  | 'delivered'
  | 'in_transit'
  // Returned to sender, cancelled, or the last delivery attempt failed.
  // Flagged for staff only: carrier data never cancels or rewinds an order.
  | 'problem'
  // The carrier has no record of the number (a typo, or not scanned yet).
  | 'not_found'
  // The number matches no known carrier's format.
  | 'unknown_carrier';

// Stored on delivery_order.tracking_snapshot after each successful check.
export type TrackingSnapshot = {
  /** The number this check was for; a later staff edit makes it stale. */
  tracking_number: string;
  carrier: Carrier | null;
  state: TrackingState;
  /** Latest carrier event, human-readable, e.g. "Out for delivery". */
  event: string | null;
  event_at: string | null;
  /** The carrier's own delivery time, ISO. Only when state is delivered. */
  delivered_at: string | null;
  checked_at: string;
};

export type TrackingResult = Omit<
  TrackingSnapshot,
  'tracking_number' | 'checked_at'
>;

export const normalizeTrackingNumber = (raw: string): string =>
  raw.replace(/\s+/g, '').toUpperCase();

const NINJA_RE = /^NV[A-Z0-9]{6,}$/;
// Pos Laju: 2-3 letters, 8-10 digits, MY (prod has EHE315326262MY, ENE…MY).
const POS_RE = /^[A-Z]{2,3}\d{8,10}MY$/;
// DHL eCommerce MY: 16 digits starting 712 (DHL's own tracking FAQ and
// tracking.my's detect rule). Prod had two, shipped 2026-10-17/18.
const DHL_RE = /^712\d{13}$/;

export function detectCarrier(trackingNumber: string): Carrier | null {
  const n = normalizeTrackingNumber(trackingNumber);
  if (NINJA_RE.test(n)) return 'ninjavan';
  if (POS_RE.test(n)) return 'poslaju';
  if (DHL_RE.test(n)) return 'dhl_ecommerce';
  return null;
}

// ---------------------------------------------------------------- Ninja Van

type NinjaEvent = {
  type?: string;
  time?: string;
  data?: { is_rts?: boolean; hub_name?: string; dp_name?: string } | null;
};
export type NinjaOrder = {
  status?: string;
  granular_status?: string;
  events?: NinjaEvent[];
};

export function classifyNinjaVan(order: NinjaOrder): TrackingResult {
  const events = [...(order.events ?? [])].sort(
    (a, b) => Date.parse(a.time ?? '') - Date.parse(b.time ?? ''),
  );
  const last = events[events.length - 1];
  const place = last?.data?.hub_name ?? last?.data?.dp_name;
  const status = order.granular_status ?? order.status ?? null;
  const base = {
    carrier: 'ninjavan' as const,
    event: status ? (place ? `${status} · ${place}` : status) : null,
    event_at: last?.time ?? null,
    delivered_at: null,
  };
  // Strict: Completed AND a success scan that is NOT a return-to-sender. A
  // returned parcel also ends in DELIVERY_SUCCESS, with is_rts: true.
  const success = events
    .filter((e) => e.type === 'DELIVERY_SUCCESS' && e.data?.is_rts === false)
    .pop();
  if (order.status === 'Completed' && success) {
    return { ...base, state: 'delivered', delivered_at: success.time ?? null };
  }
  const returned =
    /return|cancel/i.test(order.status ?? '') ||
    events.some((e) => e.data?.is_rts === true);
  if (returned || last?.type === 'DELIVERY_FAILURE') {
    return { ...base, state: 'problem' };
  }
  return { ...base, state: 'in_transit' };
}

// ----------------------------------------------------------------- Pos Laju

type PosEvent = { date?: string; process?: string; office?: string };
export type PosConnote = {
  connote_id?: string;
  process_status?: string;
  tracking_data?: PosEvent[] | null;
};

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** A Malaysia-time (UTC+8) date with a 12-hour clock -> ISO, or null for a
 *  month name it does not know. */
function malaysiaIso(
  year: string,
  monthName: string,
  day: string,
  hour12: string,
  minute: string,
  second: string,
  ampm: string,
): string | null {
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const hour = (Number(hour12) % 12) + (ampm.toUpperCase() === 'PM' ? 12 : 0);
  const utc = Date.UTC(
    Number(year),
    month,
    Number(day),
    hour - 8,
    Number(minute),
    Number(second),
  );
  return new Date(utc).toISOString();
}

/** "06 Oct 2026, 12:20:00 PM" (Malaysia time, UTC+8) -> ISO, or null. */
export function parsePosDate(s: string | undefined): string | null {
  const m =
    /^(\d{1,2}) (\w{3}) (\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/i.exec(
      (s ?? '').trim(),
    );
  return m ? malaysiaIso(m[3], m[2], m[1], m[4], m[5], m[6], m[7]) : null;
}

export function classifyPosLaju(connote: PosConnote): TrackingResult {
  const events = (connote.tracking_data ?? [])
    .map((e) => ({ ...e, at: parsePosDate(e.date) }))
    .sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''));
  const last = events[events.length - 1];
  const base = {
    carrier: 'poslaju' as const,
    event: last?.process
      ? last.office
        ? `${last.process} · ${last.office}`
        : last.process
      : null,
    event_at: last?.at ?? null,
    delivered_at: null,
  };
  if (!events.length) return { ...base, state: 'not_found' };
  const returned = events.some((e) => /return/i.test(e.process ?? ''));
  if (connote.process_status === 'DELIVERED' && !returned) {
    const done = events.filter((e) => /delivered|delivery completed/i.test(e.process ?? '')).pop();
    return { ...base, state: 'delivered', delivered_at: (done ?? last).at };
  }
  if (returned || /unsuccessful|fail/i.test(last.process ?? '')) {
    return { ...base, state: 'problem' };
  }
  return { ...base, state: 'in_transit' };
}

// ------------------------------------------------------------ DHL eCommerce

// The public tracking page is server-rendered HTML (JSF). Read from a real
// page on 2026-10-30: a timeline of rows, newest first. Each row has its event
// in <span class="d-none d-lg-block">, its place in the next text-grey div,
// and its time as "01:59 PM LT" (Malaysia time). Only a day's first row
// carries the date ("Oct 19, 2026"). A delivered parcel also carries the
// green "badge bg-delivered" header.
export function classifyDhlEcommerce(html: string): TrackingResult {
  const base = {
    carrier: 'dhl_ecommerce' as const,
    event: null,
    event_at: null,
    delivered_at: null,
  };
  const panel = html.indexOf('trackItNowForm:timelinePanel');
  if (panel < 0) {
    if (/<h4[^>]*>\s*No result found\s*<\/h4>/.test(html)) {
      return { ...base, state: 'not_found' };
    }
    // Anything else (a bot check, a redesign) is not an answer.
    throw new Error('DHL eCommerce page has no tracking timeline');
  }
  const events: { text: string; place: string | null; at: string | null }[] =
    [];
  let day: RegExpExecArray | null = null;
  const rows = html
    .slice(panel)
    .split(/class="row position-relative[^"]*tracking-item/)
    .slice(1);
  for (const row of rows) {
    day = /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\b/.exec(row) ?? day;
    const time = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*LT/.exec(row);
    const span = /<span class="d-none d-lg-block">([^<]*)<\/span>/.exec(row);
    if (!span) continue;
    // After the span: the date header uses the same text-grey class.
    const place = /<div class="text-grey-\d+">\s*([^<]+?)\s*<\/div>/.exec(
      row.slice(span.index),
    );
    events.push({
      // "Successfully delivered - Signed for by : <name>": store no name.
      text: span[1].replace(/\s*-\s*Signed for by.*$/i, '').trim(),
      place: place?.[1] ?? null,
      at:
        day && time
          ? malaysiaIso(day[3], day[1], day[2], time[1], time[2], '0', time[3])
          : null,
    });
  }
  const latest = events[0];
  if (!latest) throw new Error('DHL eCommerce timeline has no events');
  const result = {
    ...base,
    event: latest.place ? `${latest.text} · ${latest.place}` : latest.text,
    event_at: latest.at,
  };
  const returned = events.some((e) => /return/i.test(e.text));
  if (
    !returned &&
    /class="badge bg-delivered/.test(html) &&
    /successfully delivered/i.test(latest.text)
  ) {
    return { ...result, state: 'delivered', delivered_at: latest.at };
  }
  if (returned || /unsuccessful|fail|exception/i.test(latest.text)) {
    return { ...result, state: 'problem' };
  }
  return { ...result, state: 'in_transit' };
}

// ------------------------------------------------------------------ Fetching

type FetchFn = typeof fetch;
const TIMEOUT_MS = 15_000;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; Polycards shipment tracker)',
};
const POS_BATCH = 20;
const NINJA_PARALLEL = 4;
const NINJA_RETRY_MS = 1_000;

async function fetchNinjaVan(
  n: string,
  fetchFn: FetchFn,
  retried = false,
): Promise<TrackingResult> {
  // NVSG… numbers live on the SG tenant; everything else we ship is NVMY….
  const region = n.startsWith('NVSG') ? 'sg' : 'my';
  const res = await fetchFn(
    `https://api.ninjavan.co/${region}/dash/1.2/public/orders?tracking_id=${encodeURIComponent(n)}`,
    { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (res.status === 404) {
    // The 2026-10-30 prod dry run got a 404 for a delivered parcel that the
    // next call found, so ask once more before calling it unknown.
    if (!retried) {
      await new Promise((r) => setTimeout(r, NINJA_RETRY_MS));
      return fetchNinjaVan(n, fetchFn, true);
    }
    return {
      carrier: 'ninjavan',
      state: 'not_found',
      event: null,
      event_at: null,
      delivered_at: null,
    };
  }
  if (res.status === 429) throw new NinjaRateLimited();
  if (!res.ok) throw new Error(`Ninja Van HTTP ${res.status}`);
  return classifyNinjaVan((await res.json()) as NinjaOrder);
}

// Ninja Van's gateway lets about 100 lookups per IP through, then answers 429
// for 10+ minutes (probed 2026-10-30, no Retry-After). Every further call in
// that window is wasted and keeps the window full, so the run stops asking.
class NinjaRateLimited extends Error {
  constructor() {
    super('Ninja Van rate limit (429); skipped this run');
  }
}

async function fetchDhlEcommerce(
  n: string,
  fetchFn: FetchFn,
): Promise<TrackingResult> {
  const res = await fetchFn(
    `https://ecommerceportal.dhl.com/track/pages/customer/trackItNowPublic.xhtml?ref=${encodeURIComponent(n)}`,
    {
      headers: { ...HEADERS, Accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`DHL eCommerce HTTP ${res.status}`);
  return classifyDhlEcommerce(await res.text());
}

async function fetchPosLaju(
  ns: string[],
  fetchFn: FetchFn,
): Promise<Map<string, TrackingResult>> {
  const res = await fetchFn(
    'https://ttu-svc.pos.com.my/api/trackandtrace/v1/request',
    {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connote_ids: ns, culture: 'en' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Pos Laju HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; data?: PosConnote[] };
  if (body.code !== 'S0000' || !Array.isArray(body.data)) {
    throw new Error(`Pos Laju answered ${body.code ?? 'no code'}`);
  }
  const out = new Map<string, TrackingResult>();
  for (const c of body.data) {
    if (c.connote_id) {
      out.set(normalizeTrackingNumber(c.connote_id), classifyPosLaju(c));
    }
  }
  return out;
}

/**
 * Checks every number once. The map holds a result or the Error that number
 * hit; a number missing from a Pos answer comes back as an Error too, so the
 * caller never mistakes "no answer" for "not delivered".
 */
export async function trackShipments(
  trackingNumbers: string[],
  fetchFn: FetchFn = fetch,
): Promise<Map<string, TrackingResult | Error>> {
  const out = new Map<string, TrackingResult | Error>();
  const ninja: string[] = [];
  const pos: string[] = [];
  const dhl: string[] = [];
  for (const n of new Set(trackingNumbers.map(normalizeTrackingNumber))) {
    const carrier = detectCarrier(n);
    if (carrier === 'ninjavan') ninja.push(n);
    else if (carrier === 'poslaju') pos.push(n);
    else if (carrier === 'dhl_ecommerce') dhl.push(n);
    else {
      out.set(n, {
        carrier: null,
        state: 'unknown_carrier',
        event: null,
        event_at: null,
        delivered_at: null,
      });
    }
  }
  const asError = (e: unknown) =>
    e instanceof Error ? e : new Error(String(e));

  let limited: Error | undefined;
  for (let i = 0; i < ninja.length; i += NINJA_PARALLEL) {
    const batch = ninja.slice(i, i + NINJA_PARALLEL);
    if (limited) {
      for (const n of batch) out.set(n, limited);
      continue;
    }
    const settled = await Promise.allSettled(
      batch.map((n) => fetchNinjaVan(n, fetchFn)),
    );
    settled.forEach((s, j) =>
      out.set(batch[j], s.status === 'fulfilled' ? s.value : asError(s.reason)),
    );
    limited = settled
      .map((s) => (s.status === 'rejected' ? s.reason : undefined))
      .find((e) => e instanceof NinjaRateLimited);
  }

  for (let i = 0; i < pos.length; i += POS_BATCH) {
    const batch = pos.slice(i, i + POS_BATCH);
    try {
      const got = await fetchPosLaju(batch, fetchFn);
      for (const n of batch) {
        out.set(n, got.get(n) ?? new Error('Pos Laju left this number out'));
      }
    } catch (e) {
      for (const n of batch) out.set(n, asError(e));
    }
  }

  // One page at a time: it is a web page behind bot protection, not an API.
  for (const n of dhl) {
    try {
      out.set(n, await fetchDhlEcommerce(n, fetchFn));
    } catch (e) {
      out.set(n, asError(e));
    }
  }
  return out;
}
