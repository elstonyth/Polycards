import {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  computeSetWeights,
  type OddsRarity,
  type SetEntry,
} from '@acme/odds-math';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { clearPackDetailCache } from '../../../../store/packs/[slug]/route';
import { clearAdminPackListCache } from '../../route';
import { coerceOddsEntries } from '../odds/route';
import { pageAll } from '../../../../utils/page-all';
import { MAX_ADMIN_TICKETS } from '../../../../../modules/packs/lucky-draw';

// An event's entries are summed into an int4 `total_tickets`, so a huge amount
// won a few thousand times could overflow it and block the draw for good. Same
// ceiling and reason as an admin grant (lucky-draw.ts).
const MAX_TICKETS = MAX_ADMIN_TICKETS;

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// GET /admin/packs/:slug/ticket-prizes — the ticket pack editor's table. Weights
// in the stored units (1,000,000 = 100%), sets 2/3 null when inherited.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;
  const [pack] = await packs.listPacks({ slug }, { take: 1 });
  if (!pack) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }
  if (pack.prize_type !== 'tickets') {
    bad(`Pack '${slug}' holds cards, not ticket amounts.`);
  }
  const rows = await pageAll((opts) =>
    packs.listTicketPrizes({ pack_id: slug }, opts),
  );
  res.json({
    rows: rows
      .map((r) => ({
        tickets: r.tickets,
        rarity: r.rarity,
        weight: r.weight,
        weight_2: r.weight_2 ?? null,
        weight_3: r.weight_3 ?? null,
        locked: r.locked,
      }))
      .sort((a, b) => a.tickets - b.tickets),
  });
}

/** The save body, as the balancer's input: the amount is the row's key, and every
 *  other field goes through the odds route's own rules. Throws INVALID_DATA. */
export function coerceTicketPrizeEntries(raw: unknown): SetEntry[] {
  if (!Array.isArray(raw)) bad('Body must include a `rows` array.');
  const seen = new Set<number>();
  return coerceOddsEntries(
    (raw as unknown[]).map((item) => {
      const tickets = (item as { tickets?: unknown } | null)?.tickets;
      if (
        typeof tickets !== 'number' ||
        !Number.isInteger(tickets) ||
        tickets < 1 ||
        tickets > MAX_TICKETS
      ) {
        return bad(
          `Each row's 'tickets' must be a whole number from 1 to ${MAX_TICKETS}.`,
        );
      }
      if (seen.has(tickets)) {
        bad(`Duplicate amount ${tickets} — each amount may appear only once.`);
      }
      seen.add(tickets);
      const { tickets: _amount, ...rates } = item as Record<string, unknown>;
      return { ...rates, card_id: `tickets-${tickets}` };
    }),
  );
}

// POST /admin/packs/:slug/ticket-prizes — replace the pack's table: a row left
// out is removed. The same @acme/odds-math balancing as POST .../odds, so a
// ticket pack cannot drift from a card pack's rules. A live pack can be edited;
// a save only affects later spins.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { slug } = req.params;
  const entries = coerceTicketPrizeEntries(
    (req.body as { rows?: unknown } | undefined)?.rows,
  );
  const { rows: balanced, error } = computeSetWeights(entries);
  if (error) bad(error);
  // computeSetWeights keeps input order, so the two arrays line up.
  const rows = balanced.map((r, i) => ({
    tickets: Number(r.card_id.slice('tickets-'.length)),
    rarity: entries[i].rarity as OddsRarity,
    weight: r.weight,
    weight_2: r.weight_2,
    weight_3: r.weight_3,
    locked: r.locked,
  }));

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  await packs.saveTicketPrizes({
    packSlug: slug,
    rows,
    adminId: req.auth_context.actor_id,
  });

  // The amounts and tiers show on the reel. Same busts as the odds route.
  clearPackDetailCache();
  clearAdminPackListCache();
  res.json({ rows });
}
