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

// Sort key for a carrier timestamp; an unparsable one sorts first instead of
// turning the comparator into NaN.
const ms = (s: string | null | undefined) => Date.parse(s ?? '') || 0;

export function classifyNinjaVan(order: NinjaOrder): TrackingResult {
  // Anything else (an error body sent with a 200, a new wrapper) is not an
  // answer — it must not land as "in transit" over the last real one.
  if (typeof order?.status !== 'string' || !Array.isArray(order.events)) {
    throw new Error('Ninja Van answer has no status or events');
  }
  const events = [...order.events].sort((a, b) => ms(a.time) - ms(b.time));
  const last = events[events.length - 1];
  const place = last?.data?.hub_name ?? last?.data?.dp_name;
  const status = order.granular_status ?? order.status ?? null;
  const base = {
    carrier: 'ninjavan' as const,
    event: status ? (place ? `${status} · ${place}` : status) : null,
    event_at: last?.time ?? null,
    delivered_at: null,
  };
  // A return is ruled out FIRST: a returned parcel can still read "Completed"
  // (granular "Returned to Sender") and end in a success scan with is_rts.
  const returned =
    /return|cancel/i.test(`${order.status} ${order.granular_status ?? ''}`) ||
    events.some((e) => e.data?.is_rts === true);
  // Strict: Completed AND the LAST success scan is not a return-to-sender.
  const success = events.filter((e) => e.type === 'DELIVERY_SUCCESS').pop();
  if (
    !returned &&
    order.status === 'Completed' &&
    success?.data?.is_rts === false
  ) {
    return { ...base, state: 'delivered', delivered_at: success.time ?? null };
  }
  if (returned || last?.type === 'DELIVERY_FAILURE') {
    return { ...base, state: 'problem' };
  }
  return { ...base, state: 'in_transit' };
}

// ----------------------------------------------------------------- Pos Laju

type PosEvent = {
  date?: string;
  process?: string;
  office?: string;
  /** Machine code beside the English text, e.g. 'delivery_success'. */
  event_type?: string;
};
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
    .sort((a, b) => ms(a.at) - ms(b.at));
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
  const returned = events.some((e) =>
    /return|rts/i.test(`${e.event_type ?? ''} ${e.process ?? ''}`),
  );
  // The latest event must itself be the delivery: its machine code when the
  // answer carries one (live answers do), else Pos's English wording.
  const lastIsDelivery = last.event_type
    ? last.event_type === 'delivery_success'
    : /^delivery completed/i.test(last.process ?? '');
  if (connote.process_status === 'DELIVERED' && !returned && lastIsDelivery) {
    return { ...base, state: 'delivered', delivered_at: last.at };
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
//
// The page shows only the newest 5 rows behind a "Show more tracking status"
// link, and a return-to-shipper leg could hide behind it. `timeline` is the
// full list that link renders (fetchDhlEcommerce asks for it); a timeline
// still cut short is refused rather than trusted.
export function classifyDhlEcommerce(
  page: string,
  timeline: string = page,
): TrackingResult {
  const base = {
    carrier: 'dhl_ecommerce' as const,
    event: null,
    event_at: null,
    delivered_at: null,
  };
  const panel = timeline.indexOf('trackItNowForm:timelinePanel');
  if (panel < 0) {
    if (page.includes('>No result found</h4>')) {
      return { ...base, state: 'not_found' };
    }
    // Anything else (a bot check, a redesign) is not an answer.
    throw new Error('DHL eCommerce page has no tracking timeline');
  }
  if (SHOW_MORE.test(timeline.slice(panel))) {
    throw new Error('DHL eCommerce timeline is cut short');
  }
  const events: { text: string; place: string | null; at: string | null }[] =
    [];
  let day: RegExpExecArray | null = null;
  const rows = timeline
    .slice(panel)
    .split(/class="row position-relative[^"]*tracking-item/)
    .slice(1);
  for (const row of rows) {
    day = /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\b/.exec(row) ?? day;
    const time = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*LT/.exec(row);
    const span = /<span class="d-none d-lg-block">([^<]*)<\/span>/.exec(row);
    if (!span) continue;
    // After the span: the date header uses the same text-grey class. One
    // [^<]* and a trim, not lazy quantifiers around \s*, which backtrack
    // badly on long whitespace.
    const place = /<div class="text-grey-\d+">([^<]*)<\/div>/
      .exec(row.slice(span.index))?.[1]
      .trim();
    events.push({
      // "Successfully delivered - Signed for by : <name>": store no name.
      text: span[1]
        .replace(/\s*-\s*(Signed for|Received) by[\s\S]*$/i, '')
        .trim(),
      place: place || null,
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
    /class="badge bg-delivered/.test(page) &&
    /successfully delivered/i.test(latest.text)
  ) {
    return { ...result, state: 'delivered', delivered_at: latest.at };
  }
  if (returned || /unsuccessful|fail|exception/i.test(latest.text)) {
    return { ...result, state: 'problem' };
  }
  return { ...result, state: 'in_transit' };
}

const SHOW_MORE = /Show more tracking status/i;

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
// A real DHL page is ~200 KB; anything far larger is not one, and the regexes
// should never see it.
const MAX_PAGE_CHARS = 2_000_000;

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
    // Only Ninja Van's own "order not found" (code 150002) means no record;
    // a 404 without it (a moved endpoint, a proxy page) is not an answer.
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: number };
    } | null;
    if (body?.error?.code !== 150002) throw new Error('Ninja Van HTTP 404');
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
  const url = `https://ecommerceportal.dhl.com/track/pages/customer/trackItNowPublic.xhtml?ref=${encodeURIComponent(n)}`;
  const res = await fetchFn(url, {
    headers: { ...HEADERS, Accept: 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DHL eCommerce HTTP ${res.status}`);
  const page = (await res.text()).slice(0, MAX_PAGE_CHARS);
  // "Show more tracking status" is a JSF ajax postback on the same page:
  // its link id (j_idtNNN) changes between page loads, and the view state
  // lives in the session cookie, so both come from this response. Proven
  // live 2026-10-30: 5 rows -> all 11.
  const more =
    /id="(trackItNowForm:j_idt\d+)"[^>]*mojarra\.ab\(this,event,'action',0,'trackItNowForm:timelinePanel'\)/.exec(
      page,
    );
  if (!more) return classifyDhlEcommerce(page);
  const viewState = /name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/.exec(
    page,
  )?.[1];
  if (!viewState) throw new Error('DHL eCommerce page has no view state');
  const cookie = (res.headers?.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const full = await fetchFn(url, {
    method: 'POST',
    headers: {
      ...HEADERS,
      Accept: 'application/xml, text/xml',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Faces-Request': 'partial/ajax',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({
      trackItNowForm: 'trackItNowForm',
      'javax.faces.ViewState': viewState,
      'javax.faces.source': more[1],
      'javax.faces.partial.event': 'click',
      'javax.faces.partial.execute': `${more[1]} @component`,
      'javax.faces.partial.render': 'trackItNowForm:timelinePanel',
      'javax.faces.behavior.event': 'action',
      'javax.faces.partial.ajax': 'true',
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!full.ok) {
    throw new Error(`DHL eCommerce HTTP ${full.status} (full timeline)`);
  }
  return classifyDhlEcommerce(
    page,
    (await full.text()).slice(0, MAX_PAGE_CHARS),
  );
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
 * caller never mistakes "no answer" for "not delivered". No carrier call
 * starts after `deadline` (epoch ms): those numbers come back as an Error and
 * wait for the next run.
 */
export async function trackShipments(
  trackingNumbers: string[],
  fetchFn: FetchFn = fetch,
  deadline: number = Infinity,
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
  const outOfTime = new Error('Out of time this run; checked next run');
  const late = () => Date.now() > deadline;

  let limited: Error | undefined;
  for (let i = 0; i < ninja.length; i += NINJA_PARALLEL) {
    const batch = ninja.slice(i, i + NINJA_PARALLEL);
    if (limited || late()) {
      for (const n of batch) out.set(n, limited ?? outOfTime);
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
    if (late()) {
      for (const n of batch) out.set(n, outOfTime);
      continue;
    }
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
    if (late()) {
      out.set(n, outOfTime);
      continue;
    }
    try {
      out.set(n, await fetchDhlEcommerce(n, fetchFn));
    } catch (e) {
      out.set(n, asError(e));
    }
  }
  return out;
}
