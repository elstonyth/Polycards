import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// GET /admin/challenge/winners[?week=<iso>] — who the weekly settlement paid,
// and what it could NOT pay.
//
// Read-only. Settlement owns these rows; nothing here writes, marks or resends.
//
// The second half is the point: a prize card that was out of stock at
// settlement is recorded `skipped_no_stock` and otherwise only ever appears in
// one job-log line, so nobody finds it. Surfacing it turns it into a queue an
// operator can work by hand, which is what the spec always said would happen to
// those cards.

// Ten ranks × (one credits row + a card row per distinct awarded card). 200 is
// far above any real week and keeps the read bounded.
const MAX_ROWS = 200;

export interface WinnerCard {
  card_id: string;
  name: string | null;
  image: string | null;
  /** Pulls minted for this card — two unlocked stages can award the same card
   *  to the same rank. */
  qty: number;
  status: string;
}

export interface WinnerRow {
  rank: number;
  customer_id: string;
  customer_email: string | null;
  credits: number;
  cards: WinnerCard[];
  /** Community pool the week settled on, and which stages that unlocked. */
  pool_myr: number | null;
  unlocked_stages: number[];
}

type Snapshot = {
  qty?: number;
  pool_myr?: number;
  unlocked_stages?: number[];
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const weeks = await packs.challengeWinnerWeeks();

  // An unknown or unparseable `week` falls back to the latest settled one
  // rather than 400ing: this is a browsable history, the selector is the only
  // thing that produces the value, and a stale bookmark should show the newest
  // week instead of an error page.
  const asked = req.query.week;
  const wanted = typeof asked === 'string' ? asked : '';
  const weekStart =
    weeks.find((w) => w.weekStart === wanted)?.weekStart ??
    weeks[0]?.weekStart ??
    null;

  if (weekStart === null) {
    res.json({ weeks, week: null, winners: [] });
    return;
  }

  const rows = await packs.listChallengePayouts(
    { week_start: new Date(weekStart) },
    {
      select: [
        'customer_id',
        'rank',
        'kind',
        'card_id',
        'credits',
        'status',
        'snapshot',
      ],
      take: MAX_ROWS,
    },
  );

  const customerIds = [...new Set(rows.map((r) => r.customer_id))];
  const cardIds = [
    ...new Set(rows.map((r) => r.card_id).filter((id): id is string => !!id)),
  ];

  // Sequential, not Promise.all: two module services on one connection is this
  // repo's "pool is probably full" shape (same rule as playersOverview).
  const customers =
    customerIds.length > 0
      ? await req.scope
          .resolve<ICustomerModuleService>(Modules.CUSTOMER)
          .listCustomers(
            { id: customerIds },
            { select: ['id', 'email'], take: customerIds.length },
          )
      : [];
  const cards =
    cardIds.length > 0
      ? await packs.listCards(
          { id: cardIds },
          {
            select: ['id', 'name', 'image', 'slab_image'],
            take: cardIds.length,
          },
        )
      : [];
  const emailById = new Map(customers.map((c) => [c.id, c.email]));
  const cardById = new Map(cards.map((c) => [c.id, c]));

  // Grouped by CUSTOMER, not by (rank, customer): `rank` is not part of the
  // row's unique key, so two rows for one winner that disagreed on it would
  // otherwise split them into two lines. Collapsing on the customer and taking
  // the first rank keeps a winner a winner.
  const byCustomer = new Map<string, WinnerRow>();
  for (const r of rows) {
    let w = byCustomer.get(r.customer_id);
    if (!w) {
      const snap = (r.snapshot ?? {}) as Snapshot;
      w = {
        rank: r.rank,
        customer_id: r.customer_id,
        customer_email: emailById.get(r.customer_id) ?? null,
        credits: 0,
        cards: [],
        pool_myr: typeof snap.pool_myr === 'number' ? snap.pool_myr : null,
        unlocked_stages: Array.isArray(snap.unlocked_stages)
          ? snap.unlocked_stages
          : [],
      };
      byCustomer.set(r.customer_id, w);
    }
    if (r.kind === 'credits') {
      // bigNumber column — coerce at the boundary so no raw_* shaped value
      // reaches the DTO.
      w.credits += Number(r.credits ?? 0);
      continue;
    }
    const card = cardById.get(r.card_id);
    const snap = (r.snapshot ?? {}) as Snapshot;
    w.cards.push({
      card_id: r.card_id,
      name: card?.name ?? null,
      image: card?.slab_image ?? card?.image ?? null,
      qty: typeof snap.qty === 'number' ? snap.qty : 1,
      status: r.status,
    });
  }

  const winners = [...byCustomer.values()].sort((a, b) => a.rank - b.rank);
  res.json({ weeks, week: weekStart, winners });
}
