import type { MedusaRequest } from '@medusajs/framework/http';
import type PacksModuleService from '../../../modules/packs/service';
import type {
  LuckyDrawEventFacts,
  LuckyDrawEventResultRow,
  LuckyDrawPage,
  LuckyDrawResultRow,
} from '../../../modules/packs/service';
import {
  ANONYMOUS_PULLER,
  loadPullerProfiles,
  type PullerProfile,
} from '../pulls/pullers';

// The Lucky Draw store views: the service returns raw ids and tickets, this
// file turns them into the JSON the storefront parses and keeps the caches.
//
// Why caches: the draw is a synchronized read (a prize draws at a published
// minute and every open tab polls for it — the 2026-10-20 outage was exactly
// that shape). Two layers, both per process:
//  - the shared half of GET /store/lucky-draw (event, prizes, totals, top 10,
//    results) lives 10 s behind a single-flight guard; only the viewer's
//    balance and my_tickets are read per request;
//  - a drawn prize or one_winner event is immutable, so its views and entry list
//    are kept by id with no expiry (capped, oldest out). One that is not drawn
//    yet is remembered as a miss for only 2 s, so the polls at the draw minute
//    cost one query per id per 2 s and a 404 outlives the draw by at most that.
// Names are resolved when a view is first built, so a drawn result keeps the
// names it had then (a later rename shows after a restart); accepted — the
// result is a record of the draw.

export type Person = {
  who: string;
  /** Seeds the anonymous face. Named for what it is: it is NOT a draw seed. */
  face_seed: number | null;
  avatar_url: string | null;
  frame_url: string | null;
};

export type EntryView = { person: Person; tickets: number };

export type ResultView = {
  prize_id: string;
  title: string;
  image: string | null;
  value_myr: number;
  drawn_at: string;
  winner: Person | null;
  winner_tickets: number;
  total_tickets: number;
  entrant_count: number;
  /** The revealed draw seed: only a drawn prize has one. */
  seed: string;
  seed_hash: string;
  // A one_winner event's row in the results feed: the whole pot under its first
  // prize's id, which the old storefront schema needs to keep the row.
  event_id?: string;
  draw_mode?: 'one_winner';
  event_name?: string;
  prize_count?: number;
};

/** A one_winner draw's outcome. */
export type EventResultView = {
  winner: Person | null;
  winner_tickets: number;
  total_tickets: number;
  entrant_count: number;
  /** The revealed draw seed: only a drawn event has one. */
  seed: string;
  seed_hash: string;
  drawn_at: string;
};

export type EventDetail = {
  result: EventResultView;
  prizes: {
    kind: 'card' | 'credit';
    title: string;
    image: string | null;
    value_myr: number;
  }[];
  entries: EntryView[];
  ticket_index: number | null;
};

export type PrizeView = {
  id: string;
  kind: 'card' | 'credit';
  title: string;
  image: string | null;
  value_myr: number;
  draw_at: string;
  seed_hash: string;
  total_tickets: number;
  entrant_count: number;
  my_tickets: number;
  top: EntryView[];
  result: ResultView | null;
};

export type ResultDetail = {
  result: ResultView;
  entries: EntryView[];
  ticket_index: number | null;
};

type SharedPage = {
  event: {
    id: string;
    name: string;
    starts_at: string;
    ends_at: string;
    draw_mode: 'per_prize' | 'one_winner';
    seed_hash: string | null;
    total_tickets: number;
    entrant_count: number;
    top: EntryView[];
    result: EventResultView | null;
  } | null;
  prizes: Omit<PrizeView, 'my_tickets'>[];
  next_event: LuckyDrawPage['next_event'];
};

const PAGE_TTL_MS = 10_000;
const UNDRAWN_TTL_MS = 2_000;
const MAX_DRAWN_ENTRIES = 500;

let pageCache: { expires: number; body: SharedPage } | null = null;
let pageInFlight: Promise<SharedPage> | null = null;
const resultCache = new Map<string, ResultView>();
const detailCache = new Map<string, ResultDetail>();
const detailInFlight = new Map<string, Promise<ResultDetail | null>>();
// Event rows have their own maps: their prize_id is a real prize's id, whose
// mirror row must not answer for the prize routes or the other way round.
const eventRowCache = new Map<string, ResultView>();
const eventDetailCache = new Map<string, EventDetail>();
const eventDetailInFlight = new Map<string, Promise<EventDetail | null>>();
/** Prize or event id → when its "not drawn yet" answer expires. Keyed by a URL
 *  param, so capped like the others. */
const undrawnUntil = new Map<string, number>();

/** Test seam: module state outlives a test's fixtures (one jest process is one
 *  module instance), so a prior test's page would be served to the next. */
export function clearLuckyDrawCache(): void {
  pageCache = null;
  pageInFlight = null;
  resultCache.clear();
  detailCache.clear();
  detailInFlight.clear();
  eventRowCache.clear();
  eventDetailCache.clear();
  eventDetailInFlight.clear();
  undrawnUntil.clear();
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (!cache.has(key) && cache.size >= MAX_DRAWN_ENTRIES) {
    // Insertion order: the first key is the oldest.
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, value);
}

// Built field by field, never spread: the profile carries a `seed` (the face
// seed) and the handle, neither of which belongs in this payload under that name.
function toPerson(profile: PullerProfile): Person {
  return {
    who: profile.who,
    face_seed: profile.seed,
    avatar_url: profile.avatar_url,
    frame_url: profile.frame_url,
  };
}

/** One profile lookup for a set of customers. A disabled or purged account is
 *  shown as Anonymous in place (not dropped: the ranking and the ticket counts
 *  must still add up). */
async function personResolver(
  req: MedusaRequest,
  packs: PacksModuleService,
  customerIds: (string | null | undefined)[],
): Promise<(customerId: string) => Person> {
  const { disabled, profileOf } = await loadPullerProfiles(
    req,
    packs,
    customerIds,
  );
  return (customerId) =>
    toPerson(
      disabled.has(customerId)
        ? ANONYMOUS_PULLER
        : profileOf(customerId, customerId),
    );
}

function resultView(
  row: LuckyDrawResultRow,
  personOf: (customerId: string) => Person,
): ResultView {
  return {
    prize_id: row.prize_id,
    title: row.title,
    image: row.image,
    value_myr: row.value_myr,
    drawn_at: row.drawn_at,
    winner: row.winner_customer_id ? personOf(row.winner_customer_id) : null,
    winner_tickets: row.winner_tickets,
    total_tickets: row.total_tickets,
    entrant_count: row.entrant_count,
    seed: row.seed,
    seed_hash: row.seed_hash,
  };
}

function eventResultView(
  facts: LuckyDrawEventFacts,
  personOf: (customerId: string) => Person,
): EventResultView {
  return {
    winner: facts.winner_customer_id
      ? personOf(facts.winner_customer_id)
      : null,
    winner_tickets: facts.winner_tickets,
    total_tickets: facts.total_tickets,
    entrant_count: facts.entrant_count,
    seed: facts.seed,
    seed_hash: facts.seed_hash,
    drawn_at: facts.drawn_at,
  };
}

/** One row of the results feed for a whole event. */
function eventRowView(
  row: LuckyDrawEventResultRow,
  personOf: (customerId: string) => Person,
): ResultView {
  return {
    ...eventResultView(row, personOf),
    prize_id: row.prizes[0]?.id ?? row.event_id,
    title: row.event_name,
    image: row.image,
    value_myr: row.value_myr,
    event_id: row.event_id,
    draw_mode: 'one_winner',
    event_name: row.event_name,
    prize_count: row.prizes.length,
  };
}

async function buildSharedPage(
  req: MedusaRequest,
  packs: PacksModuleService,
): Promise<SharedPage> {
  const page = await packs.luckyDrawPage();
  const personOf = await personResolver(req, packs, [
    ...page.prizes.flatMap((p) => [
      ...p.top.map((t) => t.customer_id),
      p.result?.winner_customer_id,
    ]),
    ...(page.event?.top.map((t) => t.customer_id) ?? []),
    page.event?.result?.winner_customer_id,
  ]);
  const toEntry = (t: { customer_id: string; tickets: number }) => ({
    person: personOf(t.customer_id),
    tickets: t.tickets,
  });
  return {
    next_event: page.next_event,
    event: page.event && {
      ...page.event,
      top: page.event.top.map(toEntry),
      result: page.event.result
        ? eventResultView(page.event.result, personOf)
        : null,
    },
    prizes: page.prizes.map((p) => {
      const result = p.result ? resultView(p.result, personOf) : null;
      if (result) remember(resultCache, p.id, result);
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        image: p.image,
        value_myr: p.value_myr,
        draw_at: p.draw_at,
        seed_hash: p.seed_hash,
        total_tickets: p.total_tickets,
        entrant_count: p.entrant_count,
        top: p.top.map(toEntry),
        result,
      };
    }),
  };
}

/** The cached shared half. One rebuild at a time: a stampede at the draw
 *  minute shares one compute; a rejected compute rejects every waiter alike
 *  and caches nothing. */
async function sharedPage(
  req: MedusaRequest,
  packs: PacksModuleService,
): Promise<SharedPage> {
  if (pageCache && pageCache.expires > Date.now()) return pageCache.body;
  pageInFlight ??= buildSharedPage(req, packs)
    .then((body) => {
      pageCache = { expires: Date.now() + PAGE_TTL_MS, body };
      return body;
    })
    .finally(() => {
      pageInFlight = null;
    });
  return pageInFlight;
}

/** Is there a Lucky Draw to play right now: a running event with a prize not
 *  drawn yet? The public answer the Games sheet needs before sign-in, from the
 *  same cached page. An ended or fully drawn event still shows its results,
 *  but the sheet calls that "Coming soon" (operator 2026-10-25: Coming soon
 *  until the next one is set up). */
export async function luckyDrawLive(
  req: MedusaRequest,
  packs: PacksModuleService,
): Promise<boolean> {
  const { event, prizes } = await sharedPage(req, packs);
  return (
    event !== null &&
    Date.parse(event.ends_at) > Date.now() &&
    prizes.some((p) => p.result === null)
  );
}

/** The Lucky Draw page for one viewer: the cached shared half plus their own
 *  balance and tickets, read live. */
export async function luckyDrawPageFor(
  req: MedusaRequest,
  packs: PacksModuleService,
  customerId: string,
): Promise<{
  balance: number;
  event: (NonNullable<SharedPage['event']> & { my_tickets: number }) | null;
  prizes: PrizeView[];
  next_event: SharedPage['next_event'];
}> {
  const shared = await sharedPage(req, packs);
  const { event } = shared;
  // Sequential: one manager per request, no parallel queries on it.
  const balance = await packs.luckyDrawBalance(customerId);
  const mine = await packs.luckyDrawMyTickets(
    customerId,
    shared.prizes.map((p) => p.id),
  );
  const myEventTickets =
    event?.draw_mode === 'one_winner'
      ? await packs.luckyDrawMyEventTickets(customerId, event.id)
      : 0;
  return {
    balance,
    event: event && { ...event, my_tickets: myEventTickets },
    prizes: shared.prizes.map((p) => ({ ...p, my_tickets: mine[p.id] ?? 0 })),
    next_event: shared.next_event,
  };
}

/** Result views for drawn prizes, in the order asked; cache first, the rest in
 *  one batch. A prize that is not drawn is skipped. */
export async function resultViewsFor(
  req: MedusaRequest,
  packs: PacksModuleService,
  prizeIds: string[],
): Promise<ResultView[]> {
  const fresh = new Map<string, ResultView>();
  const missing = prizeIds.filter((id) => !resultCache.has(id));
  if (missing.length > 0) {
    const rows = await packs.luckyDrawResultRows(missing);
    const personOf = await personResolver(
      req,
      packs,
      rows.map((r) => r.winner_customer_id),
    );
    for (const row of rows) {
      const view = resultView(row, personOf);
      fresh.set(row.prize_id, view);
      remember(resultCache, row.prize_id, view);
    }
  }
  return prizeIds.flatMap((id) => {
    const view = fresh.get(id) ?? resultCache.get(id);
    return view ? [view] : [];
  });
}

/** The results feed in its own order: event rows and old prize rows. */
export async function resultFeedFor(
  req: MedusaRequest,
  packs: PacksModuleService,
  rows: { kind: 'event' | 'prize'; id: string }[],
): Promise<ResultView[]> {
  const prizes = new Map(
    (
      await resultViewsFor(
        req,
        packs,
        rows.filter((r) => r.kind === 'prize').map((r) => r.id),
      )
    ).map((v) => [v.prize_id, v]),
  );
  const missing = rows
    .filter((r) => r.kind === 'event' && !eventRowCache.has(r.id))
    .map((r) => r.id);
  if (missing.length > 0) {
    const found = await packs.luckyDrawEventResultRows(missing);
    const personOf = await personResolver(
      req,
      packs,
      found.map((r) => r.winner_customer_id),
    );
    for (const row of found) {
      remember(eventRowCache, row.event_id, eventRowView(row, personOf));
    }
  }
  return rows.flatMap((r) => {
    const view =
      r.kind === 'event' ? eventRowCache.get(r.id) : prizes.get(r.id);
    return view ? [view] : [];
  });
}

async function buildEventDetail(
  req: MedusaRequest,
  packs: PacksModuleService,
  eventId: string,
): Promise<EventDetail | null> {
  const found = await packs.luckyDrawEventResult(eventId);
  if (!found) {
    remember(undrawnUntil, eventId, Date.now() + UNDRAWN_TTL_MS);
    return null;
  }
  const personOf = await personResolver(req, packs, [
    found.row.winner_customer_id,
    ...found.entries.map((e) => e.customer_id),
  ]);
  const detail: EventDetail = {
    result: eventResultView(found.row, personOf),
    prizes: found.row.prizes.map((p) => ({
      kind: p.kind,
      title: p.title,
      image: p.image,
      value_myr: p.value_myr,
    })),
    entries: found.entries.map((e) => ({
      person: personOf(e.customer_id),
      tickets: e.tickets,
    })),
    ticket_index: found.ticket_index,
  };
  remember(eventDetailCache, eventId, detail);
  return detail;
}

/** One drawn one_winner event with its entry list, or null when it is not drawn
 *  (that miss is remembered for UNDRAWN_TTL_MS). Every open tab polls this at the
 *  end of an event. */
export async function eventDetailFor(
  req: MedusaRequest,
  packs: PacksModuleService,
  eventId: string,
): Promise<EventDetail | null> {
  const cached = eventDetailCache.get(eventId);
  if (cached) return cached;
  if ((undrawnUntil.get(eventId) ?? 0) > Date.now()) return null;
  let pending = eventDetailInFlight.get(eventId);
  if (!pending) {
    pending = buildEventDetail(req, packs, eventId).finally(() => {
      eventDetailInFlight.delete(eventId);
    });
    eventDetailInFlight.set(eventId, pending);
  }
  return pending;
}

async function buildDetail(
  req: MedusaRequest,
  packs: PacksModuleService,
  prizeId: string,
): Promise<ResultDetail | null> {
  const found = await packs.luckyDrawResult(prizeId);
  if (!found) {
    remember(undrawnUntil, prizeId, Date.now() + UNDRAWN_TTL_MS);
    return null;
  }
  const personOf = await personResolver(req, packs, [
    found.row.winner_customer_id,
    ...found.entries.map((e) => e.customer_id),
  ]);
  const detail: ResultDetail = {
    result: resultView(found.row, personOf),
    entries: found.entries.map((e) => ({
      person: personOf(e.customer_id),
      tickets: e.tickets,
    })),
    ticket_index: found.ticket_index,
  };
  remember(detailCache, prizeId, detail);
  remember(resultCache, prizeId, detail.result);
  return detail;
}

/** One drawn prize with its entry list, or null when it is not drawn (that
 *  miss is remembered for UNDRAWN_TTL_MS). */
export async function resultDetailFor(
  req: MedusaRequest,
  packs: PacksModuleService,
  prizeId: string,
): Promise<ResultDetail | null> {
  const cached = detailCache.get(prizeId);
  if (cached) return cached;
  if ((undrawnUntil.get(prizeId) ?? 0) > Date.now()) return null;
  let pending = detailInFlight.get(prizeId);
  if (!pending) {
    pending = buildDetail(req, packs, prizeId).finally(() => {
      detailInFlight.delete(prizeId);
    });
    detailInFlight.set(prizeId, pending);
  }
  return pending;
}
