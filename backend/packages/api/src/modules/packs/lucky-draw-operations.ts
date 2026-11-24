// Lucky Draw: gates (events), prizes, ticket entries, the seeded draw, its payout
// and the player/admin reads. The pure rules (seed, weighted pick, validators)
// are lucky-draw.ts; this module is the behaviour that reads and writes rows.
//
// It runs on a narrow port (LuckyDrawPort), never on the whole service: the
// Lucky Draw tables, cards and pulls, credit posting and the ledger, the audit
// row, the eligibility gates, and the two draws that must open their own
// transaction. PacksModuleService keeps one-line delegations under the same
// names and transaction decorators, so routes, jobs and workflows are unchanged.
// Every advisory lock key (`luckydraw:`, `luckydrawevent:`, `tickets:`), its
// order and every transaction boundary is the one the service had.
//
// Calls inside this module that already carry a context (luckyDrawBalance,
// luckyDrawMyEventTickets, luckyDrawEventResultRows, luckyDrawTicketHistory,
// saveLuckyDrawEvent) call the module function directly, not the decorated
// service method. So a spec that stubs `svc.<method>` no longer intercepts
// them; stub the port member or the SQL they run instead.
import type { Context } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import type PacksModuleService from './service';
import type { AdminAuditRow } from './service';
import type { LedgerSqlManager } from './claim';
import { disabledAccountSql } from './eligibility';
import {
  LUCKY_DRAW_PULL_PACK_ID,
  type LuckyDrawTier,
  MAX_PRIZE_CREDIT_MYR,
  aggregateEntries,
  commitDrawSeed,
  deriveDrawSeed,
  drawSeedHash,
  drawWinner,
  requireDrawSeedSecret,
  validateAdminTickets,
  validateEntryTickets,
  type EnterRefusal,
} from './lucky-draw';
import { pageAll } from '../../api/utils/page-all';
import { BONUS_BP_FULL } from './bonus-credit';
import { fromSen, toMoney, toSen } from './money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  resolveFxRate,
  DEFAULT_USD_MYR,
  displayMarketPrice,
} from './pricing';

/** What Lucky Draw needs from the rest of the packs module. */
export type LuckyDrawPort = Pick<
  PacksModuleService,
  // Its own tables.
  | 'listLuckyDrawEvents'
  | 'createLuckyDrawEvents'
  | 'updateLuckyDrawEvents'
  | 'listLuckyDrawPrizes'
  | 'createLuckyDrawPrizes'
  | 'updateLuckyDrawPrizes'
  | 'listLuckyDrawEntries'
  | 'createLuckyDrawEntries'
  | 'listLuckyDrawTickets'
  | 'createLuckyDrawTickets'
  | 'listLuckyDrawResults'
  | 'createLuckyDrawResults'
  | 'listLuckyDrawEventResults'
  | 'createLuckyDrawEventResults'
  // Prize cards, their RM value, and the pull a card prize mints.
  | 'listCards'
  | 'listFxRates'
  | 'createPulls'
  | 'updatePulls'
  // A credit prize's posting and a card prize's ledger row.
  | 'mutateCreditAtomic'
  | 'recordLedgerEntry'
  // Who may enter, and who is left out of a draw or a refund.
  | 'assertNotFrozen'
  | 'mayPlay'
  | 'assertMayReceive'
  | 'disabledCustomerIds'
  // The job loops call these WITHOUT a context: each draw opens its own
  // transaction through the service's decorator.
  | 'drawLuckyDrawPrize'
  | 'drawLuckyDrawEvent'
  | 'forceLuckyDrawWinner'
> & {
  /** The admin audit row, on the caller's transaction. */
  audit(row: AdminAuditRow, sharedContext: Context): Promise<void>;
};

/** A prize as the admin Lucky Draw overview shows it. Dates are ISO strings.
 *  There is no seed field: `result.seed` exists only for a drawn prize. */
export type AdminLuckyDrawPrize = {
  id: string;
  kind: 'card' | 'credit';
  card_handle: string | null;
  credit_myr: number | null;
  title: string;
  image_url: string | null;
  sort: number;
  draw_at: string;
  cancelled_at: string | null;
  seed_hash: string | null;
  total_tickets: number;
  entrant_count: number;
  /** RM: the credit amount, or a card's current value (null if the card is gone). */
  value_myr: number | null;
  result: {
    winner_customer_id: string | null;
    winner_tickets: number;
    total_tickets: number;
    entrant_count: number;
    drawn_at: string;
    seed: string;
    /** false only when a winner exists and nothing was minted / credited
     *  (e.g. the card was deleted before the draw): someone owes them a prize.
     *  A no-winner result owes nothing, so it is true. */
    granted: boolean;
  } | null;
};

/** What one prize's draw did, for the job after the transaction commits.
 *  `pullId` null on a card prize with a winner = the Card row was gone, so
 *  nothing was minted and someone has to fulfil it by hand. */
export interface LuckyDrawOutcome {
  prizeId: string;
  winnerId: string | null;
  kind: 'card' | 'credit';
  cardHandle: string | null;
  pullId: string | null;
}

export type AdminLuckyDrawEvent = {
  id: string;
  name: string;
  tier: LuckyDrawTier;
  starts_at: string;
  ends_at: string;
  status: 'draft' | 'published' | 'cancelled';
  draw_mode: 'per_prize' | 'one_winner';
  /** The event's own commitment: null until published, and on a per_prize
   *  event, whose hashes are per prize. */
  seed_hash: string | null;
  /** The admin-picked winner the draw job pays whatever the seed says
   *  (guaranteed win, 2026-11-24). Null = the seeded draw. */
  forced_winner_id: string | null;
  /** Entries ever made on the event itself (0 on a per_prize event). */
  total_tickets: number;
  entrant_count: number;
  prizes: AdminLuckyDrawPrize[];
};

/** A card's RM value as the vault, the task hub and the Lucky Draw admin
 *  overview show it. */
export function cardValueMyr(
  card: { market_value: unknown; market_multiplier?: unknown },
  fxRate: number,
): number {
  return displayMarketPrice(
    toMoney(card.market_value),
    fxRate,
    Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
  );
}

/** A drawn prize as the player routes show it. Ids are raw — the route
 *  resolves names. `seed` is the revealed draw seed; it exists here only
 *  because a result row does. */
export type LuckyDrawResultRow = {
  prize_id: string;
  title: string;
  image: string | null;
  frame: LuckyDrawArtFrame;
  value_myr: number;
  drawn_at: string;
  winner_customer_id: string | null;
  winner_tickets: number;
  total_tickets: number;
  entrant_count: number;
  seed: string;
  seed_hash: string;
};

export type LuckyDrawPagePrize = {
  id: string;
  kind: 'card' | 'credit';
  title: string;
  image: string | null;
  frame: LuckyDrawArtFrame;
  value_myr: number;
  draw_at: string;
  seed_hash: string;
  total_tickets: number;
  entrant_count: number;
  /** Most tickets first, raw customer ids. */
  top: { customer_id: string; tickets: number }[];
  result: LuckyDrawResultRow | null;
};

/** A one_winner draw's outcome as the player routes show it. The ids are raw;
 *  `seed` exists here only because a result row does. */
export type LuckyDrawEventFacts = {
  winner_customer_id: string | null;
  winner_tickets: number;
  total_tickets: number;
  entrant_count: number;
  seed: string;
  seed_hash: string;
  drawn_at: string;
};

/** How a prize's picture wears the Lucky Draw frame: `slab` is a baked slab, `raw`
 *  a bare card scan, null anything else (credit, or the admin's own art). */
export type LuckyDrawArtFrame = 'slab' | 'raw' | null;

/** A drawn one_winner event with what its winner took. */
export type LuckyDrawEventResultRow = LuckyDrawEventFacts & {
  event_id: string;
  event_name: string;
  tier: LuckyDrawTier;
  /** The pot's picture and its RM total. */
  image: string | null;
  frame: LuckyDrawArtFrame;
  value_myr: number;
  prizes: {
    id: string;
    kind: 'card' | 'credit';
    title: string;
    image: string | null;
    frame: LuckyDrawArtFrame;
    value_myr: number;
  }[];
};

/** One running gate on the player page: tickets go on it, one winner takes its
 *  prizes. Raw customer ids: the route resolves names. */
export type LuckyDrawPageGate = {
  id: string;
  tier: LuckyDrawTier;
  starts_at: string;
  ends_at: string;
  /** When players could first see it: its start, or its publish if that came
   *  later (a gate drafted with a start already past). What "new" goes by. */
  live_at: string;
  /** The commitment made at publish: public before any entry, so the revealed
   *  seed can be checked against it. Never the nonce. */
  seed_hash: string | null;
  total_tickets: number;
  entrant_count: number;
  /** Most tickets first. */
  top: { customer_id: string; tickets: number }[];
  prizes: {
    kind: string;
    title: string;
    image: string | null;
    frame: LuckyDrawArtFrame;
    value_myr: number;
  }[];
};

export type LuckyDrawPage = {
  /** Every running gate, soonest end first. `event`, `prizes` and `next_event`
   *  keep the one-pool shape for a storefront still deploying. */
  events: LuckyDrawPageGate[];
  event: {
    id: string;
    name: string;
    starts_at: string;
    ends_at: string;
    draw_mode: 'per_prize' | 'one_winner';
    /** The event's own commitment; null on a per_prize event. */
    seed_hash: string | null;
    total_tickets: number;
    entrant_count: number;
    /** Most tickets first, raw customer ids. Empty on a per_prize event. */
    top: { customer_id: string; tickets: number }[];
    result: LuckyDrawEventFacts | null;
  } | null;
  prizes: LuckyDrawPagePrize[];
  /** The next pool: when it runs and every prize it will hold. */
  next_event: {
    name: string;
    starts_at: string;
    ends_at: string;
    prizes: {
      kind: string;
      title: string;
      image: string | null;
      value_myr: number;
    }[];
  } | null;
};

export type LuckyDrawMine = {
  balance: number;
  history: { delta: number; reason: string; created_at: string }[];
  entries: {
    prize_id: string;
    title: string;
    image: string | null;
    frame: LuckyDrawArtFrame;
    my_tickets: number;
    draw_at: string;
    status: 'open' | 'won' | 'lost' | 'cancelled';
    /** Set on a one_winner row, where prize_id is the event id. */
    event_id?: string;
    tier?: LuckyDrawTier;
    /** One_winner rows only: every ticket in the pool, for "my chance". */
    total_tickets?: number;
  }[];
};

/** A card as the Lucky Draw routes need it: its value inputs and its picture. */
type LuckyDrawCard = {
  handle: string;
  market_value: unknown;
  market_multiplier?: unknown;
  image?: string | null;
  slab_image?: string | null;
};

/** The player page's top-entrants length. */
const LUCKY_DRAW_TOP_ENTRANTS = 10;
// Disabled (and purged) accounts are left out of every count and list built from
// lucky_draw_entry, so the totals and the top 10 are the ones the draw will use
// (owner 2026-11-12: a disabled account shows nowhere). Appended after the
// entry table's own WHERE; it must stay unaliased in those queries.
const LUCKY_DRAW_LIVE_ENTRY_SQL = `AND NOT ${disabledAccountSql('lucky_draw_entry.customer_id')} `;
/** A finished event stays on the page this long. */
const LUCKY_DRAW_LINGER_MS = 7 * 24 * 60 * 60 * 1000;
/** A draw time must be at least this far ahead when it is set or published:
 *  one already past makes the next tick write a permanent "No entries" result. */
const LUCKY_DRAW_MIN_LEAD_MS = 2 * 60 * 1000;

/** One prize of a new event, in the fields saveLuckyDrawPrize takes (minus the
 *  event and the audit ones). */
export type LuckyDrawPrizeCreateInput = {
  kind: 'card' | 'credit';
  cardHandle?: string | null;
  creditMyr?: number | null;
  title: string;
  imageUrl?: string | null;
  sort: number;
  drawAt?: Date | null;
};

const luckyDrawInvalid = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

// The event rules saveLuckyDrawEvent and createLuckyDrawEventWithPrizes share.
// Returns the trimmed name.
function checkLuckyDrawEvent(input: {
  name: string;
  startsAt: Date;
  endsAt: Date;
}): string {
  const name = input.name.trim();
  if (!name || name.length > 80) {
    luckyDrawInvalid('name is required (1–80 chars).');
  }
  const startsAt = input.startsAt.getTime();
  const endsAt = input.endsAt.getTime();
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) {
    luckyDrawInvalid('starts_at and ends_at must be valid dates.');
  }
  if (endsAt <= startsAt) {
    luckyDrawInvalid('The event end must be after its start.');
  }
  return name;
}

// The prize shape rules saveLuckyDrawPrize and createLuckyDrawEventWithPrizes
// share: exactly one of card / credit per `kind` and the credit range in
// whole sen. Returns the stored fields (draw time aside).
function checkLuckyDrawPrize(input: LuckyDrawPrizeCreateInput) {
  const title = input.title.trim();
  if (!title || title.length > 120)
    luckyDrawInvalid('title is required (1–120 chars).');
  if (!Number.isInteger(input.sort)) {
    luckyDrawInvalid('sort must be a whole number.');
  }
  if (input.kind !== 'card' && input.kind !== 'credit') {
    luckyDrawInvalid("kind must be 'card' or 'credit'.");
  }
  const cardHandle = input.cardHandle?.trim() || null;
  const imageUrl = input.imageUrl?.trim() || null;
  let creditMyr: number | null = null;
  if (input.kind === 'card') {
    if (!cardHandle) luckyDrawInvalid('A card prize needs a card.');
    if (input.creditMyr != null)
      luckyDrawInvalid('A card prize carries no credit amount.');
  } else {
    if (cardHandle) luckyDrawInvalid('A credit prize carries no card.');
    const amount = input.creditMyr;
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_PRIZE_CREDIT_MYR ||
      fromSen(toSen(amount)) !== amount
    ) {
      luckyDrawInvalid(
        `credit_myr must be a positive amount in whole sen, at most ${MAX_PRIZE_CREDIT_MYR}.`,
      );
    }
    // No image is fine: the storefront shows the credit coins.
    creditMyr = amount as number;
  }
  if (input.drawAt && Number.isNaN(input.drawAt.getTime())) {
    luckyDrawInvalid('draw_at must be a valid date.');
  }
  return {
    kind: input.kind,
    card_handle: cardHandle,
    credit_myr: creditMyr,
    title,
    image_url: imageUrl,
    sort: input.sort,
  };
}

// A new draw time must fall after the event starts and by the time it ends,
// and at least LUCKY_DRAW_MIN_LEAD_MS from now.
function checkLuckyDrawDrawTime(
  drawAt: Date,
  window: { starts_at: Date | string; ends_at: Date | string },
  now: Date,
): void {
  const at = drawAt.getTime();
  if (
    !(
      at > new Date(window.starts_at).getTime() &&
      at <= new Date(window.ends_at).getTime()
    )
  ) {
    luckyDrawInvalid(
      'The draw time must fall after the event starts and by the time it ends.',
    );
  }
  if (at <= now.getTime() + LUCKY_DRAW_MIN_LEAD_MS) {
    luckyDrawInvalid('The draw time must be at least 2 minutes from now.');
  }
}

/** A prize as its audit row records it. */
function luckyDrawPrizeAuditView(p: {
  kind: string;
  card_handle: string | null;
  credit_myr: unknown;
  title: string;
  image_url: string | null;
  sort: number;
  draw_at: unknown;
}) {
  return {
    kind: p.kind,
    card_handle: p.card_handle,
    credit_myr: p.credit_myr == null ? null : toMoney(p.credit_myr),
    title: p.title,
    image_url: p.image_url,
    sort: p.sort,
    draw_at: new Date(p.draw_at as Date).toISOString(),
  };
}
/** Prize columns the player routes read. Never `seed_nonce`: a seed must not
 *  even be loadable on a path that returns before the draw. */
const LUCKY_DRAW_PRIZE_FIELDS = [
  'id',
  'event_id',
  'kind',
  'card_handle',
  'credit_myr',
  'title',
  'image_url',
  'sort',
  'draw_at',
  'seed_hash',
  'cancelled_at',
];
/** Result columns without the frozen entry list (long). */
const LUCKY_DRAW_RESULT_FIELDS = [
  'prize_id',
  'winner_customer_id',
  'winner_tickets',
  'total_tickets',
  'entrant_count',
  'seed',
  'drawn_at',
];
/** The same for a one_winner event's result. */
const LUCKY_DRAW_EVENT_RESULT_FIELDS = [
  'event_id',
  'winner_customer_id',
  'winner_tickets',
  'total_tickets',
  'entrant_count',
  'seed',
  'drawn_at',
];
/** RM value and picture of a prize for the player routes: a credit prize is its
 *  amount; a card prize is the card's current value (0 if the card is gone).
 *  The picture is the prize's own, else the card's slab, else its scan. `frame` says
 *  how that picture wears the Lucky Draw frame, the same one the card wears in the
 *  winner's vault: stated here, not inferred from the picture by the storefront. */
function luckyDrawShown(
  prize: {
    kind: string;
    card_handle?: string | null;
    credit_myr?: unknown;
    image_url?: string | null;
  },
  cards: { cardByHandle: Map<string, LuckyDrawCard>; fxRate: number },
): { value_myr: number; image: string | null; frame: LuckyDrawArtFrame } {
  const card =
    prize.kind === 'card' && prize.card_handle
      ? cards.cardByHandle.get(prize.card_handle)
      : undefined;
  return {
    value_myr:
      prize.kind === 'credit'
        ? toMoney(prize.credit_myr)
        : card
          ? cardValueMyr(card, cards.fxRate)
          : 0,
    image: prize.image_url || card?.slab_image || card?.image || null,
    // The admin's own art is not a card picture, so it wears no frame.
    frame:
      prize.image_url || !card
        ? null
        : card.slab_image
          ? 'slab'
          : card.image
            ? 'raw'
            : null,
  };
}

/** The picture of a whole pot: its most valuable card, else its biggest credit
 *  (the storefront's heroPrize). */
function luckyDrawPotFace(
  prizes: {
    kind: string;
    image: string | null;
    frame: LuckyDrawArtFrame;
    value_myr: number;
  }[],
): { image: string | null; frame: LuckyDrawArtFrame } {
  const cards = prizes.filter((p) => p.kind === 'card');
  const face = (cards.length ? cards : prizes).reduce<
    (typeof prizes)[number] | null
  >((top, p) => (!top || p.value_myr > top.value_myr ? p : top), null);
  return { image: face?.image ?? null, frame: face?.frame ?? null };
}

function luckyDrawEventFacts(
  result: {
    winner_customer_id?: string | null;
    winner_tickets: number;
    total_tickets: number;
    entrant_count: number;
    seed: string;
    drawn_at: unknown;
  },
  seedHash: string | null | undefined,
): LuckyDrawEventFacts {
  return {
    winner_customer_id: result.winner_customer_id ?? null,
    winner_tickets: result.winner_tickets,
    total_tickets: result.total_tickets,
    entrant_count: result.entrant_count,
    seed: result.seed,
    seed_hash: seedHash ?? '',
    drawn_at: new Date(result.drawn_at as Date).toISOString(),
  };
}

// A one_winner prize has no hash of its own: `eventSeedHash` is its event's.
function luckyDrawResultRow(
  prize: { id: string; title: string; seed_hash?: string | null },
  result: {
    winner_customer_id?: string | null;
    winner_tickets: number;
    total_tickets: number;
    entrant_count: number;
    seed: string;
    drawn_at: unknown;
  },
  shown: { value_myr: number; image: string | null; frame: LuckyDrawArtFrame },
  eventSeedHash?: string | null,
): LuckyDrawResultRow {
  return {
    prize_id: prize.id,
    title: prize.title,
    image: shown.image,
    frame: shown.frame,
    value_myr: shown.value_myr,
    drawn_at: new Date(result.drawn_at as Date).toISOString(),
    winner_customer_id: result.winner_customer_id ?? null,
    winner_tickets: result.winner_tickets,
    total_tickets: result.total_tickets,
    entrant_count: result.entrant_count,
    seed: result.seed,
    seed_hash: prize.seed_hash ?? eventSeedHash ?? '',
  };
}

// A customer's Lucky Draw ticket balance: the sum of their live ledger rows
// (task claims +, entries -, refunds +, admin grants ±). 0 when none.
export async function luckyDrawBalance(
  port: LuckyDrawPort,
  customerId: string,
  sharedContext: Context = {},
): Promise<number> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<{ balance: string | number }[]>(
    'SELECT COALESCE(SUM(delta), 0) AS balance FROM lucky_draw_ticket ' +
      'WHERE customer_id = ? AND deleted_at IS NULL',
    [customerId],
  );
  return Number(rows[0]?.balance ?? 0);
}

// Spend tickets on a Lucky Draw prize. Two advisory locks, always in this
// order: the SHARED prize lock (the draw and cancel take it exclusive, so
// they wait for in-flight entries and an entry arriving after the draw sees
// its result), then the per-customer ticket lock (serialises this customer's
// spends so two parallel enters cannot both pass the balance check). Every
// read below runs on this locked transaction. `tickets` is validated before
// any lock is taken. A refusal is a return value; only a bad amount or a
// frozen or disabled account throws.
export async function enterLuckyDraw(
  port: LuckyDrawPort,
  input: {
    customerId: string;
    prizeId: string;
    tickets: unknown;
    now?: Date;
  },
  sharedContext: Context = {},
): Promise<
  | { entered: true; entryId: string; balance: number; myTickets: number }
  | { entered: false; reason: EnterRefusal }
> {
  const tickets = validateEntryTickets(input.tickets);
  const { customerId, prizeId } = input;
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  const refuse = (reason: EnterRefusal) => ({
    entered: false as const,
    reason,
  });

  await em.execute(
    'SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))',
    [`luckydraw:${prizeId}`],
  );
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `tickets:${customerId}`,
  ]);
  // Taken after the locks: a wait behind the draw must not leave a stale clock.
  const now = (input.now ?? new Date()).getTime();

  await port.assertNotFrozen(customerId, sharedContext);

  const [prize] = await port.listLuckyDrawPrizes(
    { id: prizeId },
    { take: 1 },
    sharedContext,
  );
  if (!prize || prize.cancelled_at) return refuse('not_found');
  const [event] = await port.listLuckyDrawEvents(
    { id: prize.event_id },
    { take: 1 },
    sharedContext,
  );
  // A one_winner event takes tickets on the event: enterLuckyDrawEvent.
  if (
    !event ||
    event.status !== 'published' ||
    event.draw_mode === 'one_winner'
  ) {
    return refuse('not_found');
  }

  if (now < new Date(event.starts_at).getTime()) return refuse('not_open');
  if (now >= new Date(prize.draw_at).getTime()) return refuse('closed');
  const [result] = await port.listLuckyDrawResults(
    { prize_id: prizeId },
    { take: 1 },
    sharedContext,
  );
  if (result) return refuse('closed');

  const refusal = await port.mayPlay(customerId, 'lucky_draw', sharedContext);
  if (refusal === 'unavailable') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This account is unavailable.',
    );
  }
  if (refusal) return refuse('no_topup'); // Lucky Draw's only other refusal
  const before = await luckyDrawBalance(port, customerId, sharedContext);
  if (before < tickets) return refuse('not_enough_tickets');
  // The ORM creates below are not flushed until the transaction ends, so a raw
  // read after them would miss them: take this customer's running total now.
  // Only this customer's enters write it and the ticket lock serialises them,
  // so it is exact.
  const mine = await em.execute<{ total: string | number }[]>(
    'SELECT COALESCE(SUM(tickets), 0) AS total FROM lucky_draw_entry ' +
      'WHERE prize_id = ? AND customer_id = ? AND deleted_at IS NULL',
    [prizeId, customerId],
  );

  const [entry] = await port.createLuckyDrawEntries(
    [{ prize_id: prizeId, customer_id: customerId, tickets }],
    sharedContext,
  );
  await port.createLuckyDrawTickets(
    [
      {
        customer_id: customerId,
        delta: -tickets,
        reason: 'entry' as const,
        ref: entry.id,
      },
    ],
    sharedContext,
  );

  return {
    entered: true,
    entryId: entry.id,
    balance: before - tickets,
    myTickets: Number(mine[0]?.total ?? 0) + tickets,
  };
}

// Spend tickets on a one_winner event. Two advisory locks, always in this
// order: the SHARED event lock (the draw and a withdraw take it exclusive, so
// they wait for in-flight entries, and an entry arriving after them sees the
// result or the cancelled status), then the per-customer ticket lock. The end
// is enforced here, under the lock, so the draw never filters entries by time.
// The same checks and refusals as enterLuckyDraw.
export async function enterLuckyDrawEvent(
  port: LuckyDrawPort,
  input: {
    customerId: string;
    eventId: string;
    tickets: unknown;
    now?: Date;
  },
  sharedContext: Context = {},
): Promise<
  | { entered: true; entryId: string; balance: number; myTickets: number }
  | { entered: false; reason: EnterRefusal }
> {
  const tickets = validateEntryTickets(input.tickets);
  const { customerId, eventId } = input;
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  const refuse = (reason: EnterRefusal) => ({
    entered: false as const,
    reason,
  });

  await em.execute(
    'SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))',
    [`luckydraw:${eventId}`],
  );
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `tickets:${customerId}`,
  ]);
  // Taken after the locks: a wait behind the draw must not leave a stale clock.
  const now = (input.now ?? new Date()).getTime();

  await port.assertNotFrozen(customerId, sharedContext);

  const [event] = await port.listLuckyDrawEvents(
    { id: eventId },
    { take: 1 },
    sharedContext,
  );
  if (
    !event ||
    event.status !== 'published' ||
    event.draw_mode !== 'one_winner'
  ) {
    return refuse('not_found');
  }
  if (now < new Date(event.starts_at).getTime()) return refuse('not_open');
  if (now >= new Date(event.ends_at).getTime()) return refuse('closed');
  const [result] = await port.listLuckyDrawEventResults(
    { event_id: eventId },
    { select: ['id'], take: 1 },
    sharedContext,
  );
  if (result) return refuse('closed');

  const refusal = await port.mayPlay(customerId, 'lucky_draw', sharedContext);
  if (refusal === 'unavailable') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This account is unavailable.',
    );
  }
  if (refusal) return refuse('no_topup'); // Lucky Draw's only other refusal
  const before = await luckyDrawBalance(port, customerId, sharedContext);
  if (before < tickets) return refuse('not_enough_tickets');
  // Read before the ORM creates below, which are not flushed until the
  // transaction ends. The ticket lock serialises this customer's enters.
  const mine = await luckyDrawMyEventTickets(
    port,
    customerId,
    eventId,
    sharedContext,
  );

  const [entry] = await port.createLuckyDrawEntries(
    [{ event_id: eventId, customer_id: customerId, tickets }],
    sharedContext,
  );
  await port.createLuckyDrawTickets(
    [
      {
        customer_id: customerId,
        delta: -tickets,
        reason: 'entry' as const,
        ref: entry.id,
      },
    ],
    sharedContext,
  );

  return {
    entered: true,
    entryId: entry.id,
    balance: before - tickets,
    myTickets: mine + tickets,
  };
}

// Admin: create or edit a Lucky Draw event. A new event is one_winner. A draft
// edits freely, and its prizes follow its end; once published only the name may
// change (the window is what customers saw); a cancelled event is closed. Takes
// the per-event lock so a publish or a prize save cannot interleave with an edit.
export async function saveLuckyDrawEvent(
  port: LuckyDrawPort,
  input: {
    id?: string;
    name: string;
    startsAt: Date;
    endsAt: Date;
    tier?: LuckyDrawTier;
    adminId: string;
    reason: string;
  },
  sharedContext: Context = {},
): Promise<{ id: string }> {
  const name = checkLuckyDrawEvent(input);
  const startsAt = input.startsAt.getTime();
  const endsAt = input.endsAt.getTime();

  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  if (input.id) {
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `luckydrawevent:${input.id}`,
    ]);
  }
  const [existing] = input.id
    ? await port.listLuckyDrawEvents(
        { id: input.id },
        { take: 1 },
        sharedContext,
      )
    : [];
  if (input.id && !existing) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw event ${input.id} not found.`,
    );
  }
  if (existing?.status === 'cancelled') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'A cancelled event cannot be edited.',
    );
  }
  if (
    existing?.status === 'published' &&
    (new Date(existing.starts_at).getTime() !== startsAt ||
      new Date(existing.ends_at).getTime() !== endsAt ||
      (input.tier !== undefined && input.tier !== existing.tier))
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'A published event can only be renamed — its window and tier are fixed.',
    );
  }

  const data = {
    name,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    ...(input.tier === undefined ? {} : { tier: input.tier }),
  };
  const iso = (d: unknown) => new Date(d as Date).toISOString();
  let id = existing?.id;
  if (existing) {
    await port.updateLuckyDrawEvents(
      { selector: { id: existing.id }, data },
      sharedContext,
    );
    if (
      existing.status === 'draft' &&
      new Date(existing.ends_at).getTime() !== endsAt
    ) {
      await port.updateLuckyDrawPrizes(
        {
          selector: { event_id: existing.id },
          data: { draw_at: input.endsAt },
        },
        sharedContext,
      );
    }
  } else {
    const [row] = await port.createLuckyDrawEvents(
      [
        {
          ...data,
          status: 'draft' as const,
          draw_mode: 'one_winner' as const,
          created_by: input.adminId,
        },
      ],
      sharedContext,
    );
    id = row.id;
  }
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'lucky_draw_event',
      entity_id: id as string,
      action: existing ? 'edit' : 'create',
      before: existing
        ? {
            name: existing.name,
            starts_at: iso(existing.starts_at),
            ends_at: iso(existing.ends_at),
            tier: existing.tier,
          }
        : null,
      after: {
        name,
        starts_at: iso(data.starts_at),
        ends_at: iso(data.ends_at),
        tier: input.tier ?? existing?.tier ?? 'economy',
      },
      reason: input.reason,
    },
    sharedContext,
  );
  return { id: id as string };
}

// Admin: create or edit a prize. Exactly one of card / credit per `kind`.
// A draft or a one_winner prize draws at the event's end, whatever `drawAt`
// says, and has no seed of its own. A published one_winner event takes any
// change before its start and none from the start on, under the exclusive event
// lock so the cut-off cannot race the first entry. A draft stays editable past
// its start date: nobody can enter it.
// A published per_prize event keeps the old rules: a NEW prize is committed at
// creation (nonce + seed hash, like publish used to do for the existing ones)
// and an existing prize may change only title, image and sort — kind, card,
// amount and draw time are what customers entered for. An unchanged locked
// field re-posted by the console is fine; a changed one is refused.
export async function saveLuckyDrawPrize(
  port: LuckyDrawPort,
  input: {
    id?: string;
    eventId: string;
    kind: 'card' | 'credit';
    cardHandle?: string | null;
    creditMyr?: number | null;
    title: string;
    imageUrl?: string | null;
    sort: number;
    drawAt?: Date | null;
    adminId: string;
    reason: string;
    now?: Date;
  },
  sharedContext: Context = {},
): Promise<{ id: string }> {
  const shape = checkLuckyDrawPrize(input);
  const { card_handle: cardHandle, credit_myr: creditMyr } = shape;

  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydrawevent:${input.eventId}`,
  ]);
  const [event] = await port.listLuckyDrawEvents(
    { id: input.eventId },
    { take: 1 },
    sharedContext,
  );
  if (!event) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw event ${input.eventId} not found.`,
    );
  }
  if (event.status === 'cancelled') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'A cancelled event takes no prizes.',
    );
  }
  const [existing] = input.id
    ? await port.listLuckyDrawPrizes(
        { id: input.id },
        { take: 1 },
        sharedContext,
      )
    : [];
  if (input.id && !existing) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw prize ${input.id} not found.`,
    );
  }
  if (existing && existing.event_id !== event.id) {
    luckyDrawInvalid('That prize belongs to another event.');
  }
  if (existing?.cancelled_at) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'A cancelled prize cannot be edited.',
    );
  }

  const published = event.status === 'published';
  const perPrize = published && event.draw_mode === 'per_prize';
  if (published && !perPrize) {
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `luckydraw:${event.id}`,
    ]);
    const now = (input.now ?? new Date()).getTime();
    if (now >= new Date(event.starts_at).getTime()) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'The event has started, so its prizes are locked.',
      );
    }
  }

  // Old rule: on an edit a missing draw time keeps the stored one; on a create
  // it is the event's end.
  const drawAt = perPrize
    ? (input.drawAt ?? new Date(existing ? existing.draw_at : event.ends_at))
    : new Date(event.ends_at);
  const drawChanged =
    !existing || drawAt.getTime() !== new Date(existing.draw_at).getTime();
  if (perPrize && drawChanged) {
    checkLuckyDrawDrawTime(drawAt, event, input.now ?? new Date());
  }
  // A card must exist — only when it is new, so retitling a prize whose
  // card was deleted since is not blocked.
  if (cardHandle && existing?.card_handle !== cardHandle) {
    await assertLuckyDrawCardsExist(port, [cardHandle], sharedContext);
  }

  if (
    perPrize &&
    existing &&
    (existing.kind !== input.kind ||
      (existing.card_handle ?? null) !== cardHandle ||
      (existing.credit_myr == null ? null : toMoney(existing.credit_myr)) !==
        creditMyr ||
      drawChanged)
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'A published prize can only change its title, image and sort.',
    );
  }
  // Committed before any write, so a missing secret leaves nothing behind.
  const commit =
    perPrize && !existing ? commitDrawSeed(requireDrawSeedSecret()) : null;

  const fields = { ...shape, draw_at: drawAt };
  let id = existing?.id;
  if (existing) {
    await port.updateLuckyDrawPrizes(
      { selector: { id: existing.id }, data: fields },
      sharedContext,
    );
  } else {
    const [row] = await port.createLuckyDrawPrizes(
      [{ event_id: event.id, ...fields, ...commit }],
      sharedContext,
    );
    id = row.id;
  }
  const view = luckyDrawPrizeAuditView;
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'lucky_draw_prize',
      entity_id: id as string,
      action: existing ? 'edit' : 'create',
      before: existing ? view(existing) : null,
      // The commitment hash is public; the nonce and the seed stay out.
      after: { ...view(fields), seed_hash: commit?.seed_hash ?? null },
      reason: input.reason,
    },
    sharedContext,
  );
  return { id: id as string };
}

// Admin: create a draft event together with its whole prize pool, or nothing.
// Every rule is the one saveLuckyDrawEvent / saveLuckyDrawPrize apply (the
// check* helpers), run over the whole pool BEFORE the first write, and the
// writes share one transaction. The event itself is written by
// saveLuckyDrawEvent (same row, same audit); handed this transaction it
// joins it, and a create reads nothing back, so there is nothing to flush
// first. Every prize draws at the event's end; a `drawAt` is ignored. No seeds
// are committed here — publish does that. A new event has no id yet, so there
// is no per-event lock to take.
export async function createLuckyDrawEventWithPrizes(
  port: LuckyDrawPort,
  input: {
    name: string;
    startsAt: Date;
    endsAt: Date;
    tier?: LuckyDrawTier;
    prizes: LuckyDrawPrizeCreateInput[];
    adminId: string;
    reason: string;
    now?: Date;
  },
  sharedContext: Context = {},
): Promise<{ id: string; prizeIds: string[] }> {
  checkLuckyDrawEvent(input);
  const now = input.now ?? new Date();
  const prizes = input.prizes.map((p, i) => {
    try {
      const shape = checkLuckyDrawPrize(p);
      const drawAt = input.endsAt;
      checkLuckyDrawDrawTime(
        drawAt,
        { starts_at: input.startsAt, ends_at: input.endsAt },
        now,
      );
      return { ...shape, draw_at: drawAt };
    } catch (e) {
      // Say which prize: the pool can be a hundred long.
      throw e instanceof MedusaError
        ? new MedusaError(e.type, `Prize ${i + 1}: ${e.message}`)
        : e;
    }
  });
  await assertLuckyDrawCardsExist(
    port,
    prizes.flatMap((p) => (p.card_handle ? [p.card_handle] : [])),
    sharedContext,
  );

  const { id } = await saveLuckyDrawEvent(
    port,
    {
      name: input.name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      tier: input.tier,
      adminId: input.adminId,
      reason: input.reason,
    },
    sharedContext,
  );
  const rows = prizes.length
    ? await port.createLuckyDrawPrizes(
        prizes.map((p) => ({ event_id: id, ...p })),
        sharedContext,
      )
    : [];
  for (const [i, row] of rows.entries()) {
    await port.audit(
      {
        admin_id: input.adminId,
        entity_type: 'lucky_draw_prize',
        entity_id: row.id,
        action: 'create',
        before: null,
        after: { ...luckyDrawPrizeAuditView(prizes[i]), seed_hash: null },
        reason: input.reason,
      },
      sharedContext,
    );
  }
  return { id, prizeIds: rows.map((r) => r.id) };
}

// Every handle must be a Card row. One query for the lot.
async function assertLuckyDrawCardsExist(
  port: LuckyDrawPort,
  handles: string[],
  sharedContext: Context,
): Promise<void> {
  const wanted = [...new Set(handles)];
  if (wanted.length === 0) return;
  const found = await port.listCards(
    { handle: wanted },
    { select: ['handle'], take: wanted.length },
    sharedContext,
  );
  const have = new Set(found.map((c) => c.handle));
  const missing = wanted.find((h) => !have.has(h));
  if (missing !== undefined) {
    luckyDrawInvalid(`Card '${missing}' does not exist.`);
  }
}

// Admin: take a draft event live, under the new rules whatever mode the draft
// was saved in: one winner, every prize at the event's end. The event gets its
// seed commitment here — a random nonce and the hash of the seed it derives;
// the seed itself is never written (deriveDrawSeed recomputes it at the draw).
export async function publishLuckyDrawEvent(
  port: LuckyDrawPort,
  input: { id: string; adminId: string; reason: string; now?: Date },
  sharedContext: Context = {},
): Promise<void> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydrawevent:${input.id}`,
  ]);
  const [event] = await port.listLuckyDrawEvents(
    { id: input.id },
    { take: 1 },
    sharedContext,
  );
  if (!event) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw event ${input.id} not found.`,
    );
  }
  if (event.status !== 'draft') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Only a draft event can be published (this one is ${event.status}).`,
    );
  }
  const prizes = (
    await pageAll((opts) =>
      port.listLuckyDrawPrizes({ event_id: event.id }, opts, sharedContext),
    )
  ).filter((p) => !p.cancelled_at);
  if (prizes.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Add at least one prize before publishing.',
    );
  }
  await assertLuckyDrawCardsExist(
    port,
    prizes.flatMap((p) => (p.card_handle ? [p.card_handle] : [])),
    sharedContext,
  );
  // A draft can sit until its end has passed: the next tick would draw it.
  const earliest = (input.now ?? new Date()).getTime() + LUCKY_DRAW_MIN_LEAD_MS;
  if (new Date(event.ends_at).getTime() <= earliest) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'The event end has passed or is under 2 minutes away — move it first.',
    );
  }
  const commit = commitDrawSeed(requireDrawSeedSecret());
  await port.updateLuckyDrawPrizes(
    {
      selector: { event_id: event.id },
      data: { draw_at: new Date(event.ends_at) },
    },
    sharedContext,
  );
  await port.updateLuckyDrawEvents(
    {
      id: event.id,
      status: 'published' as const,
      draw_mode: 'one_winner' as const,
      ...commit,
    },
    sharedContext,
  );
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'lucky_draw_event',
      entity_id: event.id,
      action: 'publish',
      before: { status: 'draft', draw_mode: event.draw_mode },
      // The commitment hash is public; the nonce and the seed stay out.
      after: {
        status: 'published',
        draw_mode: 'one_winner',
        seed_hash: commit.seed_hash,
        prizes: prizes.map((p) => p.id),
      },
      reason: input.reason,
    },
    sharedContext,
  );
}

// Admin: withdraw a prize before its draw and give every entrant that is not
// disabled their tickets back. Takes the EXCLUSIVE prize lock first — the same key an entry
// holds shared — so it waits for in-flight entries and an entry arriving
// afterwards is refused; the result is then re-checked under the lock, so a
// cancel racing the draw can never both pay a winner and refund. On a published
// one_winner event a prize goes only before the start (it would change what
// people entered for) and never the last one: a withdraw stops the event.
export async function cancelLuckyDrawPrize(
  port: LuckyDrawPort,
  input: { id: string; adminId: string; reason: string; now?: Date },
  sharedContext: Context = {},
): Promise<{ refunded: number }> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydraw:${input.id}`,
  ]);
  const [prize] = await port.listLuckyDrawPrizes(
    { id: input.id },
    { take: 1 },
    sharedContext,
  );
  if (!prize) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw prize ${input.id} not found.`,
    );
  }
  if (prize.cancelled_at) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'That prize is already cancelled.',
    );
  }
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydrawevent:${prize.event_id}`,
  ]);
  const [event] = await port.listLuckyDrawEvents(
    { id: prize.event_id },
    { take: 1 },
    sharedContext,
  );
  if (event?.draw_mode === 'one_winner' && event.status !== 'draft') {
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `luckydraw:${event.id}`,
    ]);
    // A withdraw that won the lock stamped this prize after it was read.
    if (event.status === 'cancelled') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'That prize is already cancelled.',
      );
    }
    const now = (input.now ?? new Date()).getTime();
    if (now >= new Date(event.starts_at).getTime()) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'The event has started, so its prizes are locked. Withdraw the event to stop it.',
      );
    }
    const others = (
      await pageAll((opts) =>
        port.listLuckyDrawPrizes({ event_id: event.id }, opts, sharedContext),
      )
    ).filter((p) => !p.cancelled_at && p.id !== prize.id);
    if (others.length === 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'A published event keeps at least one prize. Withdraw the event instead.',
      );
    }
  }
  const [result] = await port.listLuckyDrawResults(
    { prize_id: prize.id },
    { take: 1 },
    sharedContext,
  );
  if (result) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'That prize has already been drawn and cannot be cancelled.',
    );
  }
  // Read through the ORM, before this transaction writes anything: raw SQL
  // would not see rows the unit of work has not flushed yet. Paged — a
  // truncated read here is a missed refund.
  const entered = aggregateEntries(
    await pageAll((opts) =>
      port.listLuckyDrawEntries({ prize_id: prize.id }, opts, sharedContext),
    ),
  );
  // A disabled account gets no refund (owner 2026-11-12).
  const shut = await port.disabledCustomerIds(
    entered.map((e) => e.customer_id),
    sharedContext,
  );
  const entrants = entered.filter((e) => !shut.has(e.customer_id));
  const cancelledAt = new Date();
  await port.updateLuckyDrawPrizes(
    { selector: { id: prize.id }, data: { cancelled_at: cancelledAt } },
    sharedContext,
  );
  if (entrants.length > 0) {
    await port.createLuckyDrawTickets(
      entrants.map((e) => ({
        customer_id: e.customer_id,
        delta: e.tickets,
        reason: 'refund' as const,
        ref: `${prize.id}:${e.customer_id}`,
      })),
      sharedContext,
    );
  }
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'lucky_draw_prize',
      entity_id: prize.id,
      action: 'disable',
      before: { cancelled_at: null },
      after: {
        cancelled_at: cancelledAt.toISOString(),
        refunded: entrants.length,
        tickets_refunded: entrants.reduce((n, e) => n + e.tickets, 0),
      },
      reason: input.reason,
    },
    sharedContext,
  );
  return { refunded: entrants.length };
}

// Admin: stop a one_winner event and give every entrant that is not disabled
// their tickets back,
// allowed until it has a result. Takes the EXCLUSIVE event lock, so it waits for
// in-flight entries and refunds them, an entry arriving afterwards sees the
// cancelled status, and a withdraw racing the draw can never both pay and refund
// (the result is re-checked under the lock, and the status stops a later draw).
// The refund ref '<eventId>:<customerId>' is unique: an event is either drawn
// or withdrawn, and the draw itself refunds nobody.
export async function withdrawLuckyDrawEvent(
  port: LuckyDrawPort,
  input: { id: string; adminId: string; reason: string },
  sharedContext: Context = {},
): Promise<{ refunded: number }> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydrawevent:${input.id}`,
  ]);
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydraw:${input.id}`,
  ]);
  const [event] = await port.listLuckyDrawEvents(
    { id: input.id },
    { take: 1 },
    sharedContext,
  );
  if (!event) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw event ${input.id} not found.`,
    );
  }
  if (event.draw_mode !== 'one_winner' || event.status !== 'published') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Only a published one-winner event can be withdrawn.',
    );
  }
  const [result] = await port.listLuckyDrawEventResults(
    { event_id: event.id },
    { select: ['id'], take: 1 },
    sharedContext,
  );
  if (result) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'That event has already been drawn and cannot be withdrawn.',
    );
  }
  // Paged: a truncated read here is a missed refund.
  const entered = aggregateEntries(
    await pageAll((opts) =>
      port.listLuckyDrawEntries({ event_id: event.id }, opts, sharedContext),
    ),
  );
  // A disabled account gets no refund (owner 2026-11-12).
  const shut = await port.disabledCustomerIds(
    entered.map((e) => e.customer_id),
    sharedContext,
  );
  const entrants = entered.filter((e) => !shut.has(e.customer_id));
  const prizes = (
    await pageAll((opts) =>
      port.listLuckyDrawPrizes({ event_id: event.id }, opts, sharedContext),
    )
  ).filter((p) => !p.cancelled_at);
  const cancelledAt = new Date();
  await port.updateLuckyDrawEvents(
    { id: event.id, status: 'cancelled' as const },
    sharedContext,
  );
  if (prizes.length > 0) {
    await port.updateLuckyDrawPrizes(
      prizes.map((p) => ({ id: p.id, cancelled_at: cancelledAt })),
      sharedContext,
    );
  }
  if (entrants.length > 0) {
    await port.createLuckyDrawTickets(
      entrants.map((e) => ({
        customer_id: e.customer_id,
        delta: e.tickets,
        reason: 'refund' as const,
        ref: `${event.id}:${e.customer_id}`,
      })),
      sharedContext,
    );
  }
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'lucky_draw_event',
      entity_id: event.id,
      action: 'disable',
      before: { status: 'published' },
      after: {
        status: 'cancelled',
        refunded: entrants.length,
        tickets_refunded: entrants.reduce((n, e) => n + e.tickets, 0),
      },
      reason: input.reason,
    },
    sharedContext,
  );
  return { refunded: entrants.length };
}

// Admin: pick the winner of a one_winner event (guaranteed win, 2026-11-24).
// The draw job then pays that customer whatever the seed says. Takes the event
// lock then the gate lock — the draw holds the gate lock exclusive, so a pick
// cannot interleave with it, and the result is re-checked under them: a pick
// either lands before the draw or is refused after it. The customer must be a
// live entrant, so the drawn result reads like any other (a winner with
// tickets). `customerId` null clears the pick.
export async function forceLuckyDrawWinner(
  port: LuckyDrawPort,
  input: {
    id: string;
    customerId: string | null;
    adminId: string;
    reason: string;
  },
  sharedContext: Context = {},
): Promise<{ forced_winner_id: string | null }> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydrawevent:${input.id}`,
  ]);
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydraw:${input.id}`,
  ]);
  const [event] = await port.listLuckyDrawEvents(
    { id: input.id },
    { take: 1 },
    sharedContext,
  );
  if (!event) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lucky Draw event ${input.id} not found.`,
    );
  }
  if (event.draw_mode !== 'one_winner' || event.status !== 'published') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Only a published one-winner event can have a forced winner.',
    );
  }
  const [done] = await port.listLuckyDrawEventResults(
    { event_id: event.id },
    { select: ['id'], take: 1 },
    sharedContext,
  );
  if (done) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'That event has already been drawn and cannot have its winner picked.',
    );
  }
  if (input.customerId != null) {
    const entered = aggregateEntries(
      await pageAll((opts) =>
        port.listLuckyDrawEntries({ event_id: event.id }, opts, sharedContext),
      ),
    );
    const shut = await port.disabledCustomerIds(
      entered.map((e) => e.customer_id),
      sharedContext,
    );
    if (
      !entered.some((e) => e.customer_id === input.customerId) ||
      shut.has(input.customerId)
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'The forced winner must be a live entrant of the event.',
      );
    }
  }
  // Raw SQL, not the ORM: an ORM update would bump updated_at, which the
  // running-gates read treats as the gate going live again.
  await em.execute(
    'UPDATE lucky_draw_event SET forced_winner_id = ?, updated_at = updated_at ' +
      'WHERE id = ?',
    [input.customerId, event.id],
  );
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'lucky_draw_event',
      entity_id: event.id,
      action: 'edit',
      before: { forced_winner_id: event.forced_winner_id ?? null },
      after: { forced_winner_id: input.customerId },
      reason: input.reason,
    },
    sharedContext,
  );
  return { forced_winner_id: input.customerId };
}

// The once-a-minute draw job's loop. A plain read context and NO
// transaction here: each prize draws in its OWN transaction, so one bad
// prize rolls back alone and the rest still draw. The due list is raw SQL
// over committed rows (nothing is written at this level) and is only a
// hint — the lock and re-check inside drawLuckyDrawPrize are what stop a
// double draw. Card stock is taken after each commit, never inside it.
export async function drawDueLuckyDrawPrizes(
  port: LuckyDrawPort,
  deps: {
    now?: Date;
    decrementStock?: (handle: string, qty: number) => Promise<boolean>;
    /** Called after each committed draw (the job's missing-card warning). */
    onDrawn?: (outcome: LuckyDrawOutcome) => Promise<void>;
  } = {},
  sharedContext: Context = {},
): Promise<{ drawn: number; failed: number }> {
  const now = deps.now ?? new Date();
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  // shortcut: LIMIT 100, oldest first — if 100+ older due prizes fail for
  // good, newer ones starve behind them; skip prizes that keep failing (or
  // page past them) once a monthly event carries anywhere near 100 prizes.
  const due = await em.execute<{ id: string }[]>(
    'SELECT p.id FROM lucky_draw_prize p ' +
      'JOIN lucky_draw_event e ON e.id = p.event_id ' +
      "AND e.status = 'published' AND e.draw_mode = 'per_prize' " +
      'AND e.deleted_at IS NULL ' +
      'WHERE p.draw_at <= ?::timestamptz AND p.cancelled_at IS NULL ' +
      'AND p.deleted_at IS NULL AND NOT EXISTS (' +
      'SELECT 1 FROM lucky_draw_result r ' +
      'WHERE r.prize_id = p.id AND r.deleted_at IS NULL) ' +
      'ORDER BY p.draw_at ASC, p.id ASC LIMIT 100',
    [now.toISOString()],
  );
  let drawn = 0;
  let failed = 0;
  for (const { id } of due) {
    let outcome: LuckyDrawOutcome | null;
    try {
      // No context forwarded: each prize opens its own transaction.
      outcome = await port.drawLuckyDrawPrize({ prizeId: id, now });
    } catch (err) {
      // Not drawn: it stays due and the next tick retries it. The message
      // is the operator's clue (e.g. "LUCKY_DRAW_SEED_SECRET changed since
      // publish"); the job logs the count.
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn('[drawDueLuckyDrawPrizes] prize not drawn', {
        prize_id: id,
        error: String(err),
      });
      continue;
    }
    if (!outcome) continue; // drawn, cancelled or unpublished since the list
    drawn += 1;
    await reserveLuckyDrawStock(port, outcome, deps.decrementStock);
    if (!deps.onDrawn) continue;
    try {
      await deps.onDrawn(outcome);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[drawDueLuckyDrawPrizes] onDrawn failed (draw already committed)',
        { prize_id: id, error: String(err) },
      );
    }
  }
  return { drawn, failed };
}

// Draw one prize, pay its winner and write its result in ONE transaction,
// so a prize is never drawn-but-unpaid. Takes the EXCLUSIVE prize lock
// first: in-flight entries hold it shared, so the draw waits for them and
// counts them, and an entry arriving after this commit sees the result and
// is refused. Everything is re-checked under the lock; null = nothing to do
// (gone, cancelled, not due, event not published, or already drawn). Every
// read runs before the first write: raw SQL in the writers below would not
// see rows the unit of work has not flushed yet.
export async function drawLuckyDrawPrize(
  port: LuckyDrawPort,
  input: { prizeId: string; now: Date },
  sharedContext: Context = {},
): Promise<LuckyDrawOutcome | null> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydraw:${input.prizeId}`,
  ]);
  const [prize] = await port.listLuckyDrawPrizes(
    { id: input.prizeId },
    { take: 1 },
    sharedContext,
  );
  if (!prize || prize.cancelled_at) return null;
  if (new Date(prize.draw_at).getTime() > input.now.getTime()) return null;
  const [event] = await port.listLuckyDrawEvents(
    { id: prize.event_id },
    { take: 1 },
    sharedContext,
  );
  if (event?.status !== 'published' || event.draw_mode !== 'per_prize') {
    return null;
  }
  const [result] = await port.listLuckyDrawResults(
    { prize_id: prize.id },
    { take: 1 },
    sharedContext,
  );
  if (result) return null;

  // Never draw against a hash the public did not see.
  if (!prize.seed_nonce || !prize.seed_hash) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Lucky Draw prize ${prize.id} has no published seed hash.`,
    );
  }
  const seed = deriveDrawSeed(requireDrawSeedSecret(), prize.seed_nonce);
  if (drawSeedHash(seed) !== prize.seed_hash) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `LUCKY_DRAW_SEED_SECRET changed since publish — prize ${prize.id} no longer matches its published seed hash.`,
    );
  }
  const creditMyr = toMoney(prize.credit_myr);
  if (prize.kind === 'credit' && !(creditMyr > 0)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Lucky Draw prize ${prize.id} has no credit amount.`,
    );
  }

  // Every entry on the prize, with no time filter: the cut-off was enforced
  // at entry time under this lock, and app/DB clock skew must never drop an
  // accepted entry. Paged — a truncated read is a dropped entry.
  const all = aggregateEntries(
    await pageAll((opts) =>
      port.listLuckyDrawEntries({ prize_id: prize.id }, opts, sharedContext),
    ),
  );
  // Disabled (and deleted) accounts are left out of the draw and get nothing
  // back: a disabled account receives no tickets (owner 2026-11-12). Who was
  // left out stays on the result row, so an enable can be made good by hand.
  const disabled = await port.disabledCustomerIds(
    all.map((e) => e.customer_id),
    sharedContext,
  );
  const entrants = all.filter((e) => !disabled.has(e.customer_id));
  const excluded = all.filter((e) => disabled.has(e.customer_id));
  const pick = drawWinner(entrants, seed, prize.id);
  const winnerId = pick?.winner.customer_id ?? null;
  const cardHandle = prize.kind === 'card' ? (prize.card_handle ?? null) : null;
  // A card deleted since the prize was saved has no handle to mint against:
  // the result is still written (pull_id null) and the job flags it.
  const [card] =
    winnerId && cardHandle
      ? await port.listCards(
          { handle: cardHandle },
          { select: ['handle'], take: 1 },
          sharedContext,
        )
      : [];

  const { creditTransactionId, pullId } = winnerId
    ? await payLuckyDrawPrize(
        port,
        prize,
        winnerId,
        card?.handle ?? null,
        sharedContext,
      )
    : { creditTransactionId: null, pullId: null };
  await port.createLuckyDrawResults(
    [
      {
        prize_id: prize.id,
        winner_customer_id: winnerId,
        winner_tickets: pick?.winner.tickets ?? 0,
        total_tickets: pick?.totalTickets ?? 0,
        entrant_count: entrants.length,
        ticket_index: pick?.ticketIndex ?? null,
        seed,
        // The json columns are typed as Record; the result stores arrays.
        entries: entrants as unknown as Record<string, unknown>,
        excluded: excluded.map((e) => e.customer_id) as unknown as Record<
          string,
          unknown
        >,
        credit_transaction_id: creditTransactionId,
        pull_id: pullId,
        drawn_at: new Date(),
      },
    ],
    sharedContext,
  );
  return {
    prizeId: prize.id,
    winnerId,
    kind: prize.kind,
    cardHandle,
    pullId,
  };
}

// Pay one prize to its winner on the caller's transaction, so it commits or
// rolls back with the result rows. cardHandle null = the Card row is gone, so
// nothing is minted (the old-rule path; a one_winner draw refuses instead).
export async function payLuckyDrawPrize(
  port: LuckyDrawPort,
  prize: { id: string; kind: 'card' | 'credit'; credit_myr?: unknown },
  winnerId: string,
  cardHandle: string | null,
  sharedContext: Context,
): Promise<{ creditTransactionId: string | null; pullId: string | null }> {
  if (prize.kind === 'credit') {
    // Bonus credit, like a weekly-challenge money prize; claimTask's shape.
    const { id } = await port.mutateCreditAtomic(
      {
        customerId: winnerId,
        amount: toMoney(prize.credit_myr),
        reason: 'reward_credit',
        idempotencyReference: `luckydraw:${prize.id}`,
        ledger: {
          type: 'WP',
          payload: {
            type: 'WP',
            period: `luckydraw:${prize.id}`,
            stage: 0,
            rank: 0,
            sku: null,
            value: 0,
          },
        },
      },
      sharedContext,
    );
    return { creditTransactionId: id, pullId: null };
  }
  if (!cardHandle) return { creditTransactionId: null, pullId: null };
  // The settleChallengeWinner card shape. The stock take runs after the
  // transaction commits (reserveLuckyDrawStock).
  const [pull] = await port.createPulls(
    [
      {
        customer_id: winnerId,
        pack_id: LUCKY_DRAW_PULL_PACK_ID,
        flip_eligible_at: new Date(),
        card_id: cardHandle,
        order_id: null,
        rolled_at: new Date(),
        source: 'reward' as const,
        bonus_bp: BONUS_BP_FULL, // reward: sale not held (ADR 0012)
        stock_earmarked: false,
      },
    ],
    sharedContext,
  );
  // A card-only WP row, like settleChallengeWinner's: walletDelta 0, the
  // card in `sku`. No pull minted (card gone) = no row.
  await port.recordLedgerEntry(
    {
      type: 'WP',
      customerId: winnerId,
      refId: pull.id,
      walletDelta: 0,
      vaultDelta: null,
      payload: {
        type: 'WP',
        period: `luckydraw:${prize.id}`,
        stage: 0,
        rank: 0,
        sku: cardHandle,
        value: 0,
      },
    },
    sharedContext,
  );
  return { creditTransactionId: null, pullId: pull.id };
}

// The job's loop for one_winner events, shaped like drawDueLuckyDrawPrizes: a
// plain read context, and each event draws in its OWN transaction so a bad one
// rolls back alone. An event that throws (its card gone, the seed secret
// changed) has paid nothing, stays due and is retried next tick with a warning.
// Card stock is taken after each commit, one take per card prize.
export async function drawDueLuckyDrawEvents(
  port: LuckyDrawPort,
  deps: {
    now?: Date;
    decrementStock?: (handle: string, qty: number) => Promise<boolean>;
  } = {},
  sharedContext: Context = {},
): Promise<{ drawn: number; failed: number }> {
  const now = deps.now ?? new Date();
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  // shortcut: LIMIT 100, oldest first — 100+ events that fail for good would
  // starve newer ones; events are monthly, so page past them if that changes.
  const due = await em.execute<{ id: string }[]>(
    "SELECT e.id FROM lucky_draw_event e WHERE e.status = 'published' " +
      "AND e.draw_mode = 'one_winner' AND e.deleted_at IS NULL " +
      'AND e.ends_at <= ?::timestamptz AND NOT EXISTS (' +
      'SELECT 1 FROM lucky_draw_event_result r ' +
      'WHERE r.event_id = e.id AND r.deleted_at IS NULL) ' +
      'ORDER BY e.ends_at ASC, e.id ASC LIMIT 100',
    [now.toISOString()],
  );
  let drawn = 0;
  let failed = 0;
  for (const { id } of due) {
    let outcomes: LuckyDrawOutcome[] | null;
    try {
      // No context forwarded: each event opens its own transaction.
      outcomes = await port.drawLuckyDrawEvent({ eventId: id, now });
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn('[drawDueLuckyDrawEvents] event not drawn', {
        event_id: id,
        error: String(err),
      });
      continue;
    }
    if (!outcomes) continue; // drawn or withdrawn since the list
    drawn += 1;
    for (const outcome of outcomes) {
      await reserveLuckyDrawStock(port, outcome, deps.decrementStock);
    }
  }
  return { drawn, failed };
}

// Draw a one_winner event: one winner, weighted by tickets, takes every prize
// that was not cancelled. The event result, one lucky_draw_result per prize and
// every payout share ONE transaction, so an event is never left part-paid: any
// failure rolls all of it back and the job retries. The unique index on the
// event result is the backstop under the EXCLUSIVE event lock: in-flight entries
// hold it shared, so the draw waits for them and counts them, with no time
// filter (the end was enforced at entry). Null = nothing to do. Every read runs
// before the first write: the raw SQL in the payers would not see rows the unit
// of work has not flushed yet. A prize's mirror row has empty entries; the proof
// is the event result. Stock is the caller's, after commit.
export async function drawLuckyDrawEvent(
  port: LuckyDrawPort,
  input: { eventId: string; now?: Date },
  sharedContext: Context = {},
): Promise<LuckyDrawOutcome[] | null> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `luckydraw:${input.eventId}`,
  ]);
  const [event] = await port.listLuckyDrawEvents(
    { id: input.eventId },
    { take: 1 },
    sharedContext,
  );
  if (event?.status !== 'published' || event.draw_mode !== 'one_winner') {
    return null;
  }
  const now = (input.now ?? new Date()).getTime();
  if (new Date(event.ends_at).getTime() > now) return null;
  const [done] = await port.listLuckyDrawEventResults(
    { event_id: event.id },
    { select: ['id'], take: 1 },
    sharedContext,
  );
  if (done) return null;

  // Never draw against a hash the public did not see.
  if (!event.seed_nonce || !event.seed_hash) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Lucky Draw event ${event.id} has no published seed hash.`,
    );
  }
  const seed = deriveDrawSeed(requireDrawSeedSecret(), event.seed_nonce);
  if (drawSeedHash(seed) !== event.seed_hash) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `LUCKY_DRAW_SEED_SECRET changed since publish — event ${event.id} no longer matches its published seed hash.`,
    );
  }
  const prizes = (
    await pageAll(
      (opts) =>
        port.listLuckyDrawPrizes({ event_id: event.id }, opts, sharedContext),
      { sort: 'ASC', id: 'ASC' },
    )
  ).filter((p) => !p.cancelled_at);
  // A publish needs a prize and the last one cannot be cancelled, so this is a
  // broken row: drawing it would take the entrants' tickets for nothing.
  if (prizes.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Lucky Draw event ${event.id} has no live prize.`,
    );
  }
  for (const p of prizes) {
    if (p.kind === 'credit' ? !(toMoney(p.credit_myr) > 0) : !p.card_handle) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Lucky Draw prize ${p.id} has nothing to pay.`,
      );
    }
  }

  // Paged — a truncated read is a dropped entry.
  const all = aggregateEntries(
    await pageAll((opts) =>
      port.listLuckyDrawEntries({ event_id: event.id }, opts, sharedContext),
    ),
  );
  // Disabled (and deleted) accounts are left out of the draw and get nothing
  // back: a disabled account receives no tickets (owner 2026-11-12). Who was
  // left out stays on the result row, so an enable can be made good by hand.
  const disabled = await port.disabledCustomerIds(
    all.map((e) => e.customer_id),
    sharedContext,
  );
  const entrants = all.filter((e) => !disabled.has(e.customer_id));
  const excluded = all.filter((e) => disabled.has(e.customer_id));
  // A forced winner (admin pick, guaranteed win 2026-11-24) takes the pot
  // whatever the seed says: their first ticket becomes the winning index, so
  // the public entry walk still lands on them and the arena plays out the
  // same. Absent from the live entrants (disabled since the pick), the
  // seeded draw decides again.
  const forced = event.forced_winner_id
    ? entrants.find((e) => e.customer_id === event.forced_winner_id)
    : undefined;
  // eslint-disable-next-line no-console
  if (event.forced_winner_id && !forced) {
    console.warn(
      '[drawLuckyDrawEvent] forced winner not found in live entrants — seeded draw will decide',
      {
        event_id: event.id,
        forced_winner_id: event.forced_winner_id,
        entrant_count: entrants.length,
      },
    );
  }
  const pick = forced
    ? {
        winner: { customer_id: forced.customer_id, tickets: forced.tickets },
        ticketIndex: entrants
          .slice(0, entrants.indexOf(forced))
          .reduce((n, e) => n + e.tickets, 0),
        totalTickets: entrants.reduce((n, e) => n + e.tickets, 0),
      }
    : drawWinner(entrants, seed, event.id);
  const winnerId = pick?.winner.customer_id ?? null;
  // A card gone since publish: refuse the whole draw, never pay part of the pot.
  // Delete-card blocks this, so only a race or a script gets here. With nobody
  // to pay there is nothing to mint, so the card does not matter.
  if (winnerId) {
    await assertLuckyDrawCardsExist(
      port,
      prizes.flatMap((p) => (p.card_handle ? [p.card_handle] : [])),
      sharedContext,
    );
  }

  const drawnAt = new Date();
  const facts = {
    winner_customer_id: winnerId,
    winner_tickets: pick?.winner.tickets ?? 0,
    total_tickets: pick?.totalTickets ?? 0,
    entrant_count: entrants.length,
    seed,
    drawn_at: drawnAt,
  };
  const outcomes: LuckyDrawOutcome[] = [];
  const paid: {
    prize_id: string;
    credit_transaction_id: string | null;
    pull_id: string | null;
  }[] = [];
  for (const prize of prizes) {
    const cardHandle = prize.card_handle ?? null;
    const { creditTransactionId, pullId } = winnerId
      ? await payLuckyDrawPrize(
          port,
          prize,
          winnerId,
          cardHandle,
          sharedContext,
        )
      : { creditTransactionId: null, pullId: null };
    paid.push({
      prize_id: prize.id,
      credit_transaction_id: creditTransactionId,
      pull_id: pullId,
    });
    outcomes.push({
      prizeId: prize.id,
      winnerId,
      kind: prize.kind,
      cardHandle,
      pullId,
    });
  }
  await port.createLuckyDrawEventResults(
    [
      {
        ...facts,
        event_id: event.id,
        ticket_index: pick?.ticketIndex ?? null,
        entries: entrants as unknown as Record<string, unknown>,
        excluded: excluded.map((e) => e.customer_id) as unknown as Record<
          string,
          unknown
        >,
      },
    ],
    sharedContext,
  );
  await port.createLuckyDrawResults(
    paid.map((p) => ({
      ...facts,
      ...p,
      ticket_index: null,
      // The json columns are typed as Record; the result stores arrays.
      entries: [] as unknown as Record<string, unknown>,
      excluded: [] as unknown as Record<string, unknown>,
    })),
    sharedContext,
  );
  return outcomes;
}

// Take a drawn card prize's unit once its draw has COMMITTED — the
// reserveSettledStock shape (see there): adjustInventory commits on the
// inventory module's own connection and cannot roll back with the draw.
// The result row keeps the prize from being drawn again, so this runs at
// most once per prize. Failures are logged, never thrown: the prize is
// already granted, and an unflagged pull is the safe side (buyback never
// restores a unit that was not taken). qty is 1, so a take is never partial.
async function reserveLuckyDrawStock(
  port: LuckyDrawPort,
  outcome: LuckyDrawOutcome,
  decrementStock:
    | ((handle: string, qty: number) => Promise<boolean>)
    | undefined,
): Promise<void> {
  const { pullId, cardHandle } = outcome;
  if (!decrementStock || !pullId || !cardHandle) return;
  try {
    // false = untracked product: nothing counted, so nothing to flag.
    if (!(await decrementStock(cardHandle, 1))) return;
    await port.updatePulls({
      selector: { id: pullId },
      data: { stock_earmarked: true },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[drawDueLuckyDrawPrizes] stock take failed AFTER the draw committed — prize already granted, pull left unflagged; check the card stock counter',
      {
        prize_id: outcome.prizeId,
        customer_id: outcome.winnerId,
        handle: cardHandle,
        pull_id: pullId,
        error: String(err),
      },
    );
  }
}

// Admin overview: every event with its prizes' facts. A prize's seed never
// appears here until its result exists — the prize row has none to leak, and
// the only seed read is the one the draw wrote into lucky_draw_result.
// Entry counts are the entries ever made on the prize (a cancelled prize
// keeps showing what was entered before the refund).
export async function adminLuckyDrawOverview(
  port: LuckyDrawPort,
  sharedContext: Context = {},
): Promise<AdminLuckyDrawEvent[]> {
  const events = await port.listLuckyDrawEvents(
    {},
    { order: { starts_at: 'DESC', id: 'DESC' }, take: 200 },
    sharedContext,
  );
  if (events.length === 0) return [];
  const prizes = await pageAll(
    (opts) =>
      port.listLuckyDrawPrizes(
        { event_id: events.map((e) => e.id) },
        opts,
        sharedContext,
      ),
    { sort: 'ASC', id: 'ASC' },
  );
  const prizeIds = prizes.map((p) => p.id);

  const sumByPrize = await luckyDrawEntrySums(port, prizeIds, sharedContext);
  const sumByEvent = await luckyDrawEntrySums(
    port,
    events.map((e) => e.id),
    sharedContext,
    'event_id',
  );

  const results = prizeIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawResults(
          { prize_id: prizeIds },
          {
            ...opts,
            // Not `entries`: the frozen entrant list can be long.
            select: [
              ...LUCKY_DRAW_RESULT_FIELDS,
              'pull_id',
              'credit_transaction_id',
            ],
          },
          sharedContext,
        ),
      )
    : [];
  const resultByPrize = new Map(results.map((r) => [r.prize_id, r]));

  const { cardByHandle, fxRate } = await luckyDrawCards(
    port,
    prizes,
    sharedContext,
  );

  const iso = (d: unknown) => new Date(d as Date).toISOString();
  const view = (p: (typeof prizes)[number]): AdminLuckyDrawPrize => {
    const sum = sumByPrize.get(p.id);
    const result = resultByPrize.get(p.id);
    const card = p.card_handle ? cardByHandle.get(p.card_handle) : undefined;
    return {
      id: p.id,
      kind: p.kind,
      card_handle: p.card_handle ?? null,
      credit_myr: p.credit_myr == null ? null : toMoney(p.credit_myr),
      title: p.title,
      image_url: p.image_url ?? null,
      sort: p.sort,
      draw_at: iso(p.draw_at),
      cancelled_at: p.cancelled_at ? iso(p.cancelled_at) : null,
      seed_hash: p.seed_hash ?? null,
      total_tickets: sum?.total_tickets ?? 0,
      entrant_count: sum?.entrant_count ?? 0,
      value_myr:
        p.kind === 'credit'
          ? p.credit_myr == null
            ? null
            : toMoney(p.credit_myr)
          : card
            ? cardValueMyr(card, fxRate)
            : null,
      result: result
        ? {
            winner_customer_id: result.winner_customer_id ?? null,
            winner_tickets: result.winner_tickets,
            total_tickets: result.total_tickets,
            entrant_count: result.entrant_count,
            drawn_at: iso(result.drawn_at),
            seed: result.seed,
            granted:
              !result.winner_customer_id ||
              Boolean(
                p.kind === 'card'
                  ? result.pull_id
                  : result.credit_transaction_id,
              ),
          }
        : null,
    };
  };
  return events.map((e) => ({
    id: e.id,
    name: e.name,
    tier: e.tier,
    starts_at: iso(e.starts_at),
    ends_at: iso(e.ends_at),
    status: e.status,
    draw_mode: e.draw_mode,
    seed_hash: e.seed_hash ?? null,
    forced_winner_id: e.forced_winner_id ?? null,
    total_tickets: sumByEvent.get(e.id)?.total_tickets ?? 0,
    entrant_count: sumByEvent.get(e.id)?.entrant_count ?? 0,
    prizes: prizes.filter((p) => p.event_id === e.id).map(view),
  }));
}

// A customer's ticket balance and their newest ledger rows (admin support).
export async function luckyDrawTicketHistory(
  port: LuckyDrawPort,
  customerId: string,
  take: number,
  sharedContext: Context = {},
): Promise<{
  balance: number;
  rows: { delta: number; reason: string; ref: string; created_at: string }[];
}> {
  const balance = await luckyDrawBalance(port, customerId, sharedContext);
  const rows = await port.listLuckyDrawTickets(
    { customer_id: customerId },
    { order: { created_at: 'DESC', id: 'DESC' }, take },
    sharedContext,
  );
  return {
    balance,
    rows: rows.map((r) => ({
      delta: r.delta,
      reason: r.reason,
      ref: r.ref,
      created_at: new Date(r.created_at).toISOString(),
    })),
  };
}

// Admin: give (positive) or take back (negative) a customer's Lucky Draw
// tickets (operator 2026-10-25), one customer per call — the admin group
// editor loops a group's members. Takes only the per-customer ticket lock,
// the second of the two locks an entry takes, so it cannot deadlock with an
// entry, a draw or a cancel. The idempotency key makes a retried call a
// replay, scoped to the customer: the same key with a different amount is a
// CONFLICT. A take-back never leaves the balance below zero. The ledger row
// and an admin_action_audit row (entity 'customer', action 'edit', the note
// as its reason) commit together.
export async function adjustLuckyDrawTickets(
  port: LuckyDrawPort,
  input: {
    customerId: string;
    tickets: unknown;
    note: unknown;
    adminId: string;
    idempotencyKey?: unknown;
  },
  sharedContext: Context = {},
): Promise<{ tickets: number; balance: number; replayed: boolean }> {
  const tickets = validateAdminTickets(input.tickets);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 1 || note.length > 512) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A note (1–512 characters) is required.',
    );
  }
  const key = input.idempotencyKey;
  if (
    key !== undefined &&
    (typeof key !== 'string' || key.length < 1 || key.length > 200)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'idempotency_key must be a string of 1–200 characters.',
    );
  }
  const { customerId } = input;
  const ref = `admin:${customerId}:${key ?? crypto.randomUUID()}`;
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `tickets:${customerId}`,
  ]);

  const before = await luckyDrawBalance(port, customerId, sharedContext);
  const [done] = await em.execute<{ delta: number }[]>(
    "SELECT delta FROM lucky_draw_ticket WHERE reason = 'admin_grant' " +
      'AND ref = ? AND customer_id = ? AND deleted_at IS NULL',
    [ref, customerId],
  );
  if (done) {
    if (Number(done.delta) !== tickets) {
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        'This request was already applied with a different amount.',
      );
    }
    return { tickets, balance: before, replayed: true };
  }
  // After the replay: a grant that committed before the disable still answers.
  if (tickets > 0) await port.assertMayReceive(customerId, sharedContext);
  if (before + tickets < 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Only ${before.toLocaleString('en-US')} tickets to take back.`,
    );
  }

  await port.createLuckyDrawTickets(
    [
      {
        customer_id: customerId,
        delta: tickets,
        reason: 'admin_grant' as const,
        ref,
      },
    ],
    sharedContext,
  );
  // The ORM row is not flushed yet: the new balance is arithmetic.
  const balance = before + tickets;
  await port.audit(
    {
      admin_id: input.adminId,
      entity_type: 'customer',
      entity_id: customerId,
      action: 'edit',
      before: { lucky_draw_tickets: before },
      after: { lucky_draw_tickets: balance, delta: tickets, ref },
      reason: note,
    },
    sharedContext,
  );
  return { tickets, balance, replayed: false };
}

// Tickets in and distinct entrants per prize, or per one_winner event. Counts
// the entries ever made on it (a cancelled one keeps showing what was entered
// before its refund). Ids with no entries are absent from the map.
async function luckyDrawEntrySums(
  port: LuckyDrawPort,
  ids: string[],
  sharedContext: Context,
  column: 'prize_id' | 'event_id' = 'prize_id',
): Promise<Map<string, { total_tickets: number; entrant_count: number }>> {
  if (ids.length === 0) return new Map();
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<
    {
      target: string;
      total: string | number;
      entrants: string | number;
    }[]
  >(
    `SELECT ${column} AS target, COALESCE(SUM(tickets), 0) AS total, ` +
      'COUNT(DISTINCT customer_id) AS entrants FROM lucky_draw_entry ' +
      `WHERE ${column} IN (${ids.map(() => '?').join(', ')}) ` +
      `AND deleted_at IS NULL ${LUCKY_DRAW_LIVE_ENTRY_SQL}GROUP BY ${column}`,
    ids,
  );
  return new Map(
    rows.map((r) => [
      r.target,
      { total_tickets: Number(r.total), entrant_count: Number(r.entrants) },
    ]),
  );
}

// The cards behind a set of prizes, with the FX rate their RM value needs.
async function luckyDrawCards(
  port: LuckyDrawPort,
  prizes: { kind: string; card_handle?: string | null }[],
  sharedContext: Context,
): Promise<{ cardByHandle: Map<string, LuckyDrawCard>; fxRate: number }> {
  const handles = [
    ...new Set(
      prizes.flatMap((p) =>
        p.kind === 'card' && p.card_handle ? [p.card_handle] : [],
      ),
    ),
  ];
  const cards = handles.length
    ? await port.listCards(
        { handle: handles },
        {
          select: [
            'handle',
            'market_value',
            'market_multiplier',
            'image',
            'slab_image',
          ],
          take: handles.length,
        },
        sharedContext,
      )
    : [];
  return {
    cardByHandle: new Map(cards.map((c) => [c.handle, c])),
    fxRate: cards.length ? await resolveFxRate(port) : DEFAULT_USD_MYR,
  };
}

// The next pool as the player page previews it: its window and every live
// prize with its art and value. Nothing about seeds or entries: it has neither.
async function luckyDrawNextEvent(
  port: LuckyDrawPort,
  next: { id: string; name: string; starts_at: Date; ends_at: Date },
  sharedContext: Context,
): Promise<NonNullable<LuckyDrawPage['next_event']>> {
  const prizes = (
    await pageAll(
      (opts) =>
        port.listLuckyDrawPrizes(
          { event_id: next.id },
          { ...opts, select: [...LUCKY_DRAW_PRIZE_FIELDS] },
          sharedContext,
        ),
      { sort: 'ASC', id: 'ASC' },
    )
  ).filter((p) => !p.cancelled_at);
  const cards = await luckyDrawCards(port, prizes, sharedContext);
  return {
    name: next.name,
    starts_at: new Date(next.starts_at).toISOString(),
    ends_at: new Date(next.ends_at).toISOString(),
    prizes: prizes.map((p) => {
      const shown = luckyDrawShown(p, cards);
      return {
        kind: p.kind,
        title: p.title,
        image: shown.image,
        value_myr: shown.value_myr,
      };
    }),
  };
}

// The running gates: published one_winner events that have started and have no
// result yet, soonest end first. One that has ended waits here for its draw. One
// query per kind of row, however many gates run. The player page's list.
// shortcut: LIMIT 100 — far more gates than a customer can read at once; page it
// if the operator ever runs anywhere near that many together.
async function luckyDrawRunningGates(
  port: LuckyDrawPort,
  now: number,
  sharedContext: Context,
): Promise<LuckyDrawPageGate[]> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<
    {
      id: string;
      tier: LuckyDrawTier;
      starts_at: Date;
      ends_at: Date;
      live_at: Date;
      seed_hash: string | null;
    }[]
  >(
    // A published event's row only changes on a rename, so updated_at is its
    // publish; the draw, prize saves and entries never touch it.
    'SELECT e.id, e.tier, e.starts_at, e.ends_at, e.seed_hash, ' +
      'GREATEST(e.starts_at, e.updated_at) AS live_at ' +
      'FROM lucky_draw_event e ' +
      "WHERE e.status = 'published' AND e.draw_mode = 'one_winner' " +
      'AND e.deleted_at IS NULL AND e.starts_at <= ?::timestamptz ' +
      'AND NOT EXISTS (SELECT 1 FROM lucky_draw_event_result r ' +
      'WHERE r.event_id = e.id AND r.deleted_at IS NULL) ' +
      'ORDER BY e.ends_at ASC, e.id ASC LIMIT 100',
    [new Date(now).toISOString()],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const prizes = (
    await pageAll(
      (opts) =>
        port.listLuckyDrawPrizes(
          { event_id: ids },
          { ...opts, select: [...LUCKY_DRAW_PRIZE_FIELDS] },
          sharedContext,
        ),
      { sort: 'ASC', id: 'ASC' },
    )
  ).filter((p) => !p.cancelled_at);
  const cards = await luckyDrawCards(port, prizes, sharedContext);
  const sums = await luckyDrawEntrySums(port, ids, sharedContext, 'event_id');
  const topRows = await em.execute<
    { event_id: string; customer_id: string; tickets: string | number }[]
  >(
    'SELECT event_id, customer_id, tickets FROM (' +
      'SELECT event_id, customer_id, SUM(tickets) AS tickets, ' +
      'ROW_NUMBER() OVER (PARTITION BY event_id ' +
      'ORDER BY SUM(tickets) DESC, customer_id ASC) AS rn ' +
      'FROM lucky_draw_entry ' +
      `WHERE event_id IN (${ids.map(() => '?').join(', ')}) ` +
      'AND deleted_at IS NULL ' +
      LUCKY_DRAW_LIVE_ENTRY_SQL +
      'GROUP BY event_id, customer_id' +
      ') ranked WHERE rn <= ? ORDER BY event_id, rn',
    [...ids, LUCKY_DRAW_TOP_ENTRANTS],
  );
  return rows.flatMap((r) => {
    const own = prizes.filter((p) => p.event_id === r.id);
    if (own.length === 0) return [];
    return [
      {
        id: r.id,
        tier: r.tier,
        starts_at: new Date(r.starts_at).toISOString(),
        ends_at: new Date(r.ends_at).toISOString(),
        live_at: new Date(r.live_at).toISOString(),
        seed_hash: r.seed_hash,
        total_tickets: sums.get(r.id)?.total_tickets ?? 0,
        entrant_count: sums.get(r.id)?.entrant_count ?? 0,
        top: topRows
          .filter((t) => t.event_id === r.id)
          .map((t) => ({
            customer_id: t.customer_id,
            tickets: Number(t.tickets),
          })),
        prizes: own.map((p) => ({
          kind: p.kind,
          title: p.title,
          ...luckyDrawShown(p, cards),
        })),
      },
    ];
  });
}

// The player page's shared part: the running event with something left to draw
// (so a fully drawn event can never hide a live one), else the latest event that
// was drawn or ended within 7 days (either needs a prize that is not cancelled),
// its prizes with totals, the top entrants (raw ids) and, for drawn prizes, the
// result; a one_winner event also has its own totals, top entrants and result.
// `next_event` is the next published event with a live prize, whatever else
// shows. Everything here is the same for every viewer, so the route caches it;
// the viewer's own balance and tickets come from luckyDrawBalance /
// luckyDrawMyTickets / luckyDrawMyEventTickets. Cancelled prizes are left out.
// A seed is read only from a result row.
export async function luckyDrawPage(
  port: LuckyDrawPort,
  input: { now?: Date } = {},
  sharedContext: Context = {},
): Promise<LuckyDrawPage> {
  const now = (input.now ?? new Date()).getTime();
  const at = (d: unknown) => new Date(d as Date).getTime();
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const gates = await luckyDrawRunningGates(port, now, sharedContext);
  const published = await port.listLuckyDrawEvents(
    { status: 'published' },
    { order: { starts_at: 'DESC', id: 'DESC' }, take: 50 },
    sharedContext,
  );
  // An event whose prizes were all cancelled must not hide a live or recent
  // one: only events with a live prize count.
  const inWindow = published.filter(
    (e) =>
      at(e.starts_at) <= now && now - at(e.ends_at) <= LUCKY_DRAW_LINGER_MS,
  );
  const leftToDraw = new Map(
    inWindow.length
      ? (
          await em.execute<
            {
              event_id: string;
              left_to_draw: boolean;
              last_drawn_at: Date | null;
            }[]
          >(
            'SELECT p.event_id, BOOL_OR(r.id IS NULL) AS left_to_draw, ' +
              'MAX(r.drawn_at) AS last_drawn_at ' +
              'FROM lucky_draw_prize p LEFT JOIN lucky_draw_result r ' +
              'ON r.prize_id = p.id AND r.deleted_at IS NULL ' +
              `WHERE p.event_id IN (${inWindow.map(() => '?').join(', ')}) ` +
              'AND p.cancelled_at IS NULL AND p.deleted_at IS NULL ' +
              'GROUP BY p.event_id',
            inWindow.map((e) => e.id),
          )
        ).map((r) => [r.event_id, r] as const)
      : [],
  );
  const finishedAt = (e: { id: string; ends_at: unknown }) =>
    at(leftToDraw.get(e.id)?.last_drawn_at ?? e.ends_at);
  const events = inWindow.filter((e) => leftToDraw.has(e.id));
  const event =
    events.find(
      (e) => now < at(e.ends_at) && leftToDraw.get(e.id)?.left_to_draw,
    ) ?? events.sort((a, b) => finishedAt(b) - finishedAt(a))[0];
  const [next] = await em.execute<
    { id: string; name: string; starts_at: Date; ends_at: Date }[]
  >(
    'SELECT e.id, e.name, e.starts_at, e.ends_at FROM lucky_draw_event e ' +
      "WHERE e.status = 'published' AND e.deleted_at IS NULL " +
      'AND e.starts_at > ?::timestamptz AND EXISTS (' +
      'SELECT 1 FROM lucky_draw_prize p WHERE p.event_id = e.id ' +
      'AND p.cancelled_at IS NULL AND p.deleted_at IS NULL) ' +
      'ORDER BY e.starts_at ASC, e.id ASC LIMIT 1',
    [new Date(now).toISOString()],
  );
  const next_event = next
    ? await luckyDrawNextEvent(port, next, sharedContext)
    : null;
  if (!event) return { events: gates, event: null, prizes: [], next_event };

  const prizes = (
    await pageAll(
      (opts) =>
        port.listLuckyDrawPrizes(
          { event_id: event.id },
          { ...opts, select: [...LUCKY_DRAW_PRIZE_FIELDS] },
          sharedContext,
        ),
      { sort: 'ASC', id: 'ASC' },
    )
  ).filter((p) => !p.cancelled_at);
  const prizeIds = prizes.map((p) => p.id);
  const sums = await luckyDrawEntrySums(port, prizeIds, sharedContext);

  // Per prize, the top entrants: tickets summed per customer, most first
  // (customer id breaks a tie so the order is stable).
  const topRows = prizeIds.length
    ? await em.execute<
        {
          prize_id: string;
          customer_id: string;
          tickets: string | number;
        }[]
      >(
        'SELECT prize_id, customer_id, tickets FROM (' +
          'SELECT prize_id, customer_id, SUM(tickets) AS tickets, ' +
          'ROW_NUMBER() OVER (PARTITION BY prize_id ' +
          'ORDER BY SUM(tickets) DESC, customer_id ASC) AS rn ' +
          'FROM lucky_draw_entry ' +
          `WHERE prize_id IN (${prizeIds.map(() => '?').join(', ')}) ` +
          'AND deleted_at IS NULL ' +
          LUCKY_DRAW_LIVE_ENTRY_SQL +
          'GROUP BY prize_id, customer_id' +
          ') ranked WHERE rn <= ? ORDER BY prize_id, rn',
        [...prizeIds, LUCKY_DRAW_TOP_ENTRANTS],
      )
    : [];
  const topByPrize = new Map<string, LuckyDrawPagePrize['top']>();
  for (const r of topRows) {
    const list = topByPrize.get(r.prize_id) ?? [];
    list.push({ customer_id: r.customer_id, tickets: Number(r.tickets) });
    topByPrize.set(r.prize_id, list);
  }

  const results = prizeIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawResults(
          { prize_id: prizeIds },
          { ...opts, select: [...LUCKY_DRAW_RESULT_FIELDS] },
          sharedContext,
        ),
      )
    : [];
  const resultByPrize = new Map(results.map((r) => [r.prize_id, r]));
  const cards = await luckyDrawCards(port, prizes, sharedContext);

  const oneWinner = event.draw_mode === 'one_winner';
  const [eventResult] = oneWinner
    ? await port.listLuckyDrawEventResults(
        { event_id: event.id },
        { take: 1 },
        sharedContext,
      )
    : [];
  const eventSum = oneWinner
    ? (
        await luckyDrawEntrySums(port, [event.id], sharedContext, 'event_id')
      ).get(event.id)
    : undefined;
  // Drawn: the numbers and the list the draw used, after any exclusions.
  let top: { customer_id: string; tickets: number }[] = [];
  if (eventResult) {
    top = [
      ...(eventResult.entries as unknown as {
        customer_id: string;
        tickets: number;
      }[]),
    ]
      .sort(
        (a, b) =>
          b.tickets - a.tickets || (a.customer_id < b.customer_id ? -1 : 1),
      )
      .slice(0, LUCKY_DRAW_TOP_ENTRANTS);
  } else if (oneWinner) {
    top = (
      await em.execute<{ customer_id: string; tickets: string | number }[]>(
        'SELECT customer_id, SUM(tickets) AS tickets FROM lucky_draw_entry ' +
          'WHERE event_id = ? AND deleted_at IS NULL ' +
          LUCKY_DRAW_LIVE_ENTRY_SQL +
          'GROUP BY customer_id ' +
          'ORDER BY SUM(tickets) DESC, customer_id ASC LIMIT ?',
        [event.id, LUCKY_DRAW_TOP_ENTRANTS],
      )
    ).map((r) => ({
      customer_id: r.customer_id,
      tickets: Number(r.tickets),
    }));
  }

  return {
    events: gates,
    next_event,
    event: {
      id: event.id,
      name: event.name,
      starts_at: new Date(event.starts_at).toISOString(),
      ends_at: new Date(event.ends_at).toISOString(),
      draw_mode: event.draw_mode,
      seed_hash: event.seed_hash ?? null,
      total_tickets: eventResult?.total_tickets ?? eventSum?.total_tickets ?? 0,
      entrant_count: eventResult?.entrant_count ?? eventSum?.entrant_count ?? 0,
      top,
      result: eventResult
        ? luckyDrawEventFacts(eventResult, event.seed_hash)
        : null,
    },
    prizes: prizes.map((p) => {
      const shown = luckyDrawShown(p, cards);
      const result = resultByPrize.get(p.id);
      const sum = sums.get(p.id);
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        image: shown.image,
        frame: shown.frame,
        value_myr: shown.value_myr,
        draw_at: new Date(p.draw_at).toISOString(),
        seed_hash: p.seed_hash ?? '',
        // A drawn prize shows the numbers the draw used (after exclusions).
        total_tickets: result?.total_tickets ?? sum?.total_tickets ?? 0,
        entrant_count: result?.entrant_count ?? sum?.entrant_count ?? 0,
        top: topByPrize.get(p.id) ?? [],
        result: result
          ? luckyDrawResultRow(p, result, shown, event.seed_hash)
          : null,
      };
    }),
  };
}

// The viewer's own tickets on each of the given prizes (absent = 0).
export async function luckyDrawMyTickets(
  port: LuckyDrawPort,
  customerId: string,
  prizeIds: string[],
  sharedContext: Context = {},
): Promise<Record<string, number>> {
  if (prizeIds.length === 0) return {};
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<
    { prize_id: string; tickets: string | number }[]
  >(
    'SELECT prize_id, COALESCE(SUM(tickets), 0) AS tickets ' +
      'FROM lucky_draw_entry WHERE customer_id = ? ' +
      `AND prize_id IN (${prizeIds.map(() => '?').join(', ')}) ` +
      'AND deleted_at IS NULL GROUP BY prize_id',
    [customerId, ...prizeIds],
  );
  return Object.fromEntries(rows.map((r) => [r.prize_id, Number(r.tickets)]));
}

// The viewer's own tickets in a one_winner event (0 when none).
export async function luckyDrawMyEventTickets(
  port: LuckyDrawPort,
  customerId: string,
  eventId: string,
  sharedContext: Context = {},
): Promise<number> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<{ tickets: string | number }[]>(
    'SELECT COALESCE(SUM(tickets), 0) AS tickets FROM lucky_draw_entry ' +
      'WHERE customer_id = ? AND event_id = ? AND deleted_at IS NULL',
    [customerId, eventId],
  );
  return Number(rows[0]?.tickets ?? 0);
}

// The viewer's own tickets on each of the given gates (absent = 0).
export async function luckyDrawMyGateTickets(
  port: LuckyDrawPort,
  customerId: string,
  eventIds: string[],
  sharedContext: Context = {},
): Promise<Record<string, number>> {
  if (eventIds.length === 0) return {};
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<
    { event_id: string; tickets: string | number }[]
  >(
    'SELECT event_id, COALESCE(SUM(tickets), 0) AS tickets ' +
      'FROM lucky_draw_entry WHERE customer_id = ? ' +
      `AND event_id IN (${eventIds.map(() => '?').join(', ')}) ` +
      'AND deleted_at IS NULL GROUP BY event_id',
    [customerId, ...eventIds],
  );
  return Object.fromEntries(rows.map((r) => [r.event_id, Number(r.tickets)]));
}

// The event a card still has to be paid from: the name of a published event
// with an undrawn live prize on that card, or null. Delete-card refuses while
// there is one.
export async function luckyDrawEventHoldingCard(
  port: LuckyDrawPort,
  handle: string,
  sharedContext: Context = {},
): Promise<string | null> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const [row] = await em.execute<{ name: string }[]>(
    'SELECT e.name FROM lucky_draw_prize p ' +
      'JOIN lucky_draw_event e ON e.id = p.event_id ' +
      "AND e.status = 'published' AND e.deleted_at IS NULL " +
      'WHERE p.card_handle = ? AND p.cancelled_at IS NULL ' +
      'AND p.deleted_at IS NULL AND NOT EXISTS (' +
      'SELECT 1 FROM lucky_draw_result r ' +
      'WHERE r.prize_id = p.id AND r.deleted_at IS NULL) ' +
      'ORDER BY e.ends_at ASC, e.id ASC LIMIT 1',
    [handle],
  );
  return row?.name ?? null;
}

// One page of the results feed, newest draw first: one row per one_winner event
// plus each drawn per_prize prize, never a one_winner event's mirror rows. Raw
// ids (callers batch-load through luckyDrawEventResultRows and
// luckyDrawResultRows) and the cursor for the next page. `before` is exclusive.
// shortcut: the cursor is the last draw time alone, so two results drawn in
// the same millisecond across a page edge would skip one; draws commit one
// transaction at a time, so move to a (drawn_at, id) cursor if that changes.
export async function luckyDrawResultPage(
  port: LuckyDrawPort,
  input: { before?: Date | null; limit: number },
  sharedContext: Context = {},
): Promise<{
  rows: { kind: 'event' | 'prize'; id: string }[];
  nextBefore: string | null;
}> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<
    { kind: 'event' | 'prize'; id: string; drawn_at: Date }[]
  >(
    'SELECT kind, id, drawn_at FROM (' +
      "SELECT 'event' AS kind, event_id AS id, drawn_at, id AS row_id " +
      'FROM lucky_draw_event_result WHERE deleted_at IS NULL ' +
      'UNION ALL ' +
      "SELECT 'prize', r.prize_id, r.drawn_at, r.id FROM lucky_draw_result r " +
      'JOIN lucky_draw_prize p ON p.id = r.prize_id ' +
      'JOIN lucky_draw_event e ON e.id = p.event_id ' +
      "AND e.draw_mode = 'per_prize' WHERE r.deleted_at IS NULL" +
      ') feed ' +
      (input.before ? 'WHERE drawn_at < ?::timestamptz ' : '') +
      'ORDER BY drawn_at DESC, row_id DESC LIMIT ?',
    [...(input.before ? [input.before.toISOString()] : []), input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  return {
    rows: page.map((r) => ({ kind: r.kind, id: r.id })),
    nextBefore:
      rows.length > input.limit
        ? new Date(page[page.length - 1].drawn_at).toISOString()
        : null,
  };
}

// Result rows for the given drawn prizes (no entry lists). A prize with no
// result is simply absent.
export async function luckyDrawResultRows(
  port: LuckyDrawPort,
  prizeIds: string[],
  sharedContext: Context = {},
): Promise<LuckyDrawResultRow[]> {
  if (prizeIds.length === 0) return [];
  const results = await port.listLuckyDrawResults(
    { prize_id: prizeIds },
    { select: [...LUCKY_DRAW_RESULT_FIELDS], take: prizeIds.length },
    sharedContext,
  );
  if (results.length === 0) return [];
  const prizes = await port.listLuckyDrawPrizes(
    { id: results.map((r) => r.prize_id) },
    { select: [...LUCKY_DRAW_PRIZE_FIELDS], take: results.length },
    sharedContext,
  );
  const prizeById = new Map(prizes.map((p) => [p.id, p]));
  const cards = await luckyDrawCards(port, prizes, sharedContext);
  const hashes = await luckyDrawEventSeedHashes(port, prizes, sharedContext);
  return results.flatMap((r) => {
    const prize = prizeById.get(r.prize_id);
    return prize
      ? [
          luckyDrawResultRow(
            prize,
            r,
            luckyDrawShown(prize, cards),
            hashes.get(prize.event_id),
          ),
        ]
      : [];
  });
}

// The events' hashes for prizes without their own (one_winner mirror rows).
async function luckyDrawEventSeedHashes(
  port: LuckyDrawPort,
  prizes: { event_id: string; seed_hash?: string | null }[],
  sharedContext: Context,
): Promise<Map<string, string | null>> {
  const ids = [
    ...new Set(prizes.filter((p) => !p.seed_hash).map((p) => p.event_id)),
  ];
  const events = ids.length
    ? await port.listLuckyDrawEvents(
        { id: ids },
        { select: ['id', 'seed_hash'], take: ids.length },
        sharedContext,
      )
    : [];
  return new Map(events.map((e) => [e.id, e.seed_hash ?? null]));
}

// Result rows for the given drawn one_winner events (no entry lists), each with
// what its winner took. An event with no result is simply absent.
export async function luckyDrawEventResultRows(
  port: LuckyDrawPort,
  eventIds: string[],
  sharedContext: Context = {},
): Promise<LuckyDrawEventResultRow[]> {
  if (eventIds.length === 0) return [];
  const results = await port.listLuckyDrawEventResults(
    { event_id: eventIds },
    { select: [...LUCKY_DRAW_EVENT_RESULT_FIELDS], take: eventIds.length },
    sharedContext,
  );
  if (results.length === 0) return [];
  const drawn = results.map((r) => r.event_id);
  const events = await port.listLuckyDrawEvents(
    { id: drawn },
    { select: ['id', 'name', 'seed_hash', 'tier'], take: drawn.length },
    sharedContext,
  );
  const eventById = new Map(events.map((e) => [e.id, e]));
  const prizes = (
    await pageAll(
      (opts) =>
        port.listLuckyDrawPrizes(
          { event_id: drawn },
          { ...opts, select: [...LUCKY_DRAW_PRIZE_FIELDS] },
          sharedContext,
        ),
      { sort: 'ASC', id: 'ASC' },
    )
  ).filter((p) => !p.cancelled_at);
  const cards = await luckyDrawCards(port, prizes, sharedContext);
  return results.flatMap((r) => {
    const event = eventById.get(r.event_id);
    if (!event) return [];
    const pot = prizes
      .filter((p) => p.event_id === r.event_id)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        ...luckyDrawShown(p, cards),
      }));
    return [
      {
        ...luckyDrawEventFacts(r, event.seed_hash),
        event_id: r.event_id,
        event_name: event.name,
        tier: event.tier,
        ...luckyDrawPotFace(pot),
        // In sen: 0.1 + 0.2 must not print a float tail.
        value_myr:
          pot.reduce((sen, p) => sen + Math.round(p.value_myr * 100), 0) / 100,
        prizes: pot,
      },
    ];
  });
}

// One drawn one_winner event with its frozen entry list (in draw order) and
// winning ticket index, or null when it has not been drawn.
export async function luckyDrawEventResult(
  port: LuckyDrawPort,
  eventId: string,
  sharedContext: Context = {},
): Promise<{
  row: LuckyDrawEventResultRow;
  entries: { customer_id: string; tickets: number }[];
  ticket_index: number | null;
} | null> {
  const [row] = await luckyDrawEventResultRows(port, [eventId], sharedContext);
  if (!row) return null;
  const [result] = await port.listLuckyDrawEventResults(
    { event_id: eventId },
    { select: ['entries', 'ticket_index'], take: 1 },
    sharedContext,
  );
  const stored: unknown = result?.entries;
  return {
    row,
    entries: Array.isArray(stored)
      ? (stored as { customer_id: string; tickets: number }[])
      : [],
    ticket_index: result?.ticket_index ?? null,
  };
}

// One drawn prize with its frozen entry list (in draw order) and winning
// ticket index, or null when it has not been drawn.
export async function luckyDrawResult(
  port: LuckyDrawPort,
  prizeId: string,
  sharedContext: Context = {},
): Promise<{
  row: LuckyDrawResultRow;
  entries: { customer_id: string; tickets: number }[];
  ticket_index: number | null;
} | null> {
  const [result] = await port.listLuckyDrawResults(
    { prize_id: prizeId },
    { take: 1 },
    sharedContext,
  );
  if (!result) return null;
  const [prize] = await port.listLuckyDrawPrizes(
    { id: prizeId },
    { select: [...LUCKY_DRAW_PRIZE_FIELDS], take: 1 },
    sharedContext,
  );
  if (!prize) return null;
  const cards = await luckyDrawCards(port, [prize], sharedContext);
  const hashes = await luckyDrawEventSeedHashes(port, [prize], sharedContext);
  const stored: unknown = result.entries;
  return {
    row: luckyDrawResultRow(
      prize,
      result,
      luckyDrawShown(prize, cards),
      hashes.get(prize.event_id),
    ),
    entries: Array.isArray(stored)
      ? (stored as { customer_id: string; tickets: number }[])
      : [],
    ticket_index: result.ticket_index ?? null,
  };
}

// A player's Lucky Draw page: balance, their last 100 ticket movements and
// every prize or one_winner event they have entered with its outcome (an event
// row has prize_id = the event id). Self-contained (no names).
export async function luckyDrawMine(
  port: LuckyDrawPort,
  customerId: string,
  sharedContext: Context = {},
): Promise<LuckyDrawMine> {
  const { balance, rows } = await luckyDrawTicketHistory(
    port,
    customerId,
    100,
    sharedContext,
  );
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const entered = await em.execute<
    { prize_id: string; tickets: string | number }[]
  >(
    'SELECT prize_id, SUM(tickets) AS tickets FROM lucky_draw_entry ' +
      'WHERE customer_id = ? AND prize_id IS NOT NULL ' +
      'AND deleted_at IS NULL GROUP BY prize_id',
    [customerId],
  );
  const enteredEvents = await em.execute<
    { event_id: string; tickets: string | number }[]
  >(
    'SELECT event_id, SUM(tickets) AS tickets FROM lucky_draw_entry ' +
      'WHERE customer_id = ? AND event_id IS NOT NULL ' +
      'AND deleted_at IS NULL GROUP BY event_id',
    [customerId],
  );
  const ticketsByEvent = new Map(
    enteredEvents.map((r) => [r.event_id, Number(r.tickets)]),
  );
  const eventIds = [...ticketsByEvent.keys()];
  const events = eventIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawEvents(
          { id: eventIds },
          { ...opts, select: ['id', 'name', 'ends_at', 'status', 'tier'] },
          sharedContext,
        ),
      )
    : [];
  const eventPrizes = eventIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawPrizes(
          { event_id: eventIds },
          { ...opts, select: [...LUCKY_DRAW_PRIZE_FIELDS] },
          sharedContext,
        ),
      )
    : [];
  const eventResults = eventIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawEventResults(
          { event_id: eventIds },
          {
            ...opts,
            select: ['event_id', 'winner_customer_id', 'total_tickets'],
          },
          sharedContext,
        ),
      )
    : [];
  const eventResultById = new Map(eventResults.map((r) => [r.event_id, r]));
  const eventSums = await luckyDrawEntrySums(
    port,
    eventIds,
    sharedContext,
    'event_id',
  );
  const ticketsByPrize = new Map(
    entered.map((r) => [r.prize_id, Number(r.tickets)]),
  );
  const prizeIds = [...ticketsByPrize.keys()];
  const prizes = prizeIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawPrizes(
          { id: prizeIds },
          { ...opts, select: [...LUCKY_DRAW_PRIZE_FIELDS] },
          sharedContext,
        ),
      )
    : [];
  const results = prizeIds.length
    ? await pageAll((opts) =>
        port.listLuckyDrawResults(
          { prize_id: prizeIds },
          { ...opts, select: ['prize_id', 'winner_customer_id'] },
          sharedContext,
        ),
      )
    : [];
  const resultByPrize = new Map(results.map((r) => [r.prize_id, r]));
  const cards = await luckyDrawCards(
    port,
    [...prizes, ...eventPrizes],
    sharedContext,
  );
  const eventRows = events.map((e): LuckyDrawMine['entries'][number] => {
    const result = eventResultById.get(e.id);
    return {
      prize_id: e.id,
      event_id: e.id,
      tier: e.tier,
      title: e.name,
      // A withdrawn event's prizes are all cancelled: it still has a face.
      ...luckyDrawPotFace(
        eventPrizes
          .filter(
            (p) =>
              p.event_id === e.id &&
              (e.status === 'cancelled' || !p.cancelled_at),
          )
          .map((p) => ({ kind: p.kind, ...luckyDrawShown(p, cards) })),
      ),
      my_tickets: ticketsByEvent.get(e.id) ?? 0,
      total_tickets:
        result?.total_tickets ?? eventSums.get(e.id)?.total_tickets ?? 0,
      draw_at: new Date(e.ends_at).toISOString(),
      status:
        e.status === 'cancelled'
          ? 'cancelled'
          : !result
            ? 'open'
            : result.winner_customer_id === customerId
              ? 'won'
              : 'lost',
    };
  });
  const entries = prizes
    .map((p): LuckyDrawMine['entries'][number] => {
      const result = resultByPrize.get(p.id);
      const status: LuckyDrawMine['entries'][number]['status'] = p.cancelled_at
        ? 'cancelled'
        : !result
          ? 'open'
          : result.winner_customer_id === customerId
            ? 'won'
            : 'lost';
      return {
        prize_id: p.id,
        title: p.title,
        image: luckyDrawShown(p, cards).image,
        frame: luckyDrawShown(p, cards).frame,
        my_tickets: ticketsByPrize.get(p.id) ?? 0,
        draw_at: new Date(p.draw_at).toISOString(),
        status,
      };
    })
    .concat(eventRows)
    // Latest draw first: what is still open sits above what is over.
    .sort((a, b) =>
      a.draw_at === b.draw_at
        ? a.prize_id < b.prize_id
          ? 1
          : -1
        : a.draw_at < b.draw_at
          ? 1
          : -1,
    )
    .slice(0, 100);
  return {
    balance,
    history: rows.map((r) => ({
      delta: r.delta,
      reason: r.reason,
      created_at: r.created_at,
    })),
    entries,
  };
}
