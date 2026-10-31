import { MedusaError } from '@medusajs/framework/utils';
import { pageAll } from '../../api/utils/page-all';
import { assertInStock, secureRoll } from '../../workflows/steps/roll-pack';
import { pickWonRow } from './pick';
import { weightForSet, type OddsSet, type SetWeights } from './odds-sets';
import type PacksModuleService from './service';

// A ticket pack's draw (spec 2026-10-30 §3): the same CSPRNG and weighted pick as
// a card pack, over ticket_prize rows, on the rate set of the customer's group.

type TicketPrizeRates = SetWeights & { tickets: number; rarity: string };

/** rarity is display only (reel frame, reveal sound) and lives on the prize row,
 *  not on ticket_spin, so the caller keeps it from here to its response. */
export type TicketRoll = { tickets: number; rarity: string };

/** The art on every reel tile; the amount is drawn on top by the storefront. */
const TICKET_IMAGE = '/images/lucky-draw/ticket.webp';

/** One independent draw. `roll` is injectable only so a test can force a row. */
export function drawTickets(
  rows: readonly TicketPrizeRates[],
  set: OddsSet,
  roll?: number,
): TicketRoll {
  const resolved = rows.map((r) => ({ ...r, weight: weightForSet(r, set) }));
  const total = resolved.reduce((sum, r) => sum + r.weight, 0);
  if (total <= 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This pack has no ticket amounts to win.',
    );
  }
  const won = pickWonRow(resolved, roll ?? secureRoll(total));
  return { tickets: won.tickets, rarity: won.rarity };
}

/** Validate the pack and draw `count` spins, before anything is charged. The
 *  same refusals a card pack's roll gives (see fetchPackData). */
export async function rollTicketSpins(
  packs: PacksModuleService,
  slug: string,
  set: OddsSet,
  count: number,
  /** The caller has checked this customer's group can see Drafts. */
  allowDraft = false,
): Promise<{ unitPrice: number; rolls: TicketRoll[] }> {
  const [pack] = await packs.listPacks(
    allowDraft ? { slug } : { slug, status: 'active' },
    { take: 1 },
  );
  if (!pack || pack.category === 'reward_box' || pack.prize_type !== 'tickets') {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pack '${slug}' is not available.`,
    );
  }
  assertInStock(pack);
  const rows = await pageAll((opts) =>
    packs.listTicketPrizes({ pack_id: slug }, opts),
  );
  return {
    unitPrice: Number(pack.price),
    rolls: Array.from({ length: count }, () => drawTickets(rows, set)),
  };
}

/** The public pool: one row per amount, smallest first. 🔒 No weight: the real
 *  rates stay secret, as on a card pack. */
export function ticketOddsRows(rows: readonly TicketPrizeRates[]) {
  return [...rows]
    .sort((a, b) => a.tickets - b.tickets)
    .map((r) => ({
      handle: `tickets-${r.tickets}`,
      tickets: r.tickets,
      name: `${r.tickets} Tickets`,
      rarity: r.rarity,
      market_value: 0,
      image: TICKET_IMAGE,
    }));
}
