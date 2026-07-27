import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { pageAll } from '../../../../utils/page-all';
import { toMoney } from '../../../../../modules/packs/money';
import {
  resolveFxRate,
  displayMarketPrice,
  DEFAULT_MARKET_MULTIPLIER,
} from '../../../../../modules/packs/pricing';
import { cardByHandle } from '../../../../../modules/packs/card-view';
import { levelForSpend } from '../../../../../modules/packs/vip-ladder';

const RECENT = 50;

// GET /admin/customers/:id/gacha — the support view aggregate: one customer's
// identity, credit balance, recent ledger, recent pulls (card-joined like the
// admin pull ledger), and a vault summary (count + FMV currently owed). Reads
// only; the adjust POST lives at ../credits.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;

  const customerService: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER,
  );
  const [customer] = await customerService.listCustomers({ id }, { take: 1 });
  if (!customer) {
    res.status(404).json({ message: `Customer '${id}' not found` });
    return;
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const [balance, transactions, pulls, vaulted, fx] = await Promise.all([
    packs.creditBalance(id),
    packs.listCreditTransactions(
      { customer_id: id },
      { order: { created_at: 'DESC' }, take: RECENT },
    ),
    packs.listPulls(
      { customer_id: id },
      { order: { rolled_at: 'DESC' }, take: RECENT },
    ),
    // Vault summary scans ALL vaulted pulls (not just the recent slice) so
    // the FMV-owed number is exact at any vault size.
    pageAll((opts) =>
      packs.listPulls({ customer_id: id, status: 'vaulted' }, opts),
    ),
    // FMV is stored USD; the support view shows MYR at the live rate (no markup).
    resolveFxRate(packs),
  ]);

  // Card join over both lists (handles are the stable key, like /store/vault).
  const handles = [...new Set([...pulls, ...vaulted].map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const byHandle = cardByHandle(cards);

  // One pass, two integer-cent accumulators: `fmv` is the raw FMV owed
  // (multiplier 1, what the operator would pay out), `display` is the same
  // vault priced the way the storefront shows it (FMV × the card's own
  // multiplier). Summed together so the two can't drift apart.
  const cents = (value: number): number =>
    Number.isFinite(value) ? Math.round(value * 100) : 0;
  const vaultCents = vaulted.reduce(
    (sum, p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return sum;
      const usd = toMoney(card.market_value);
      return {
        fmv: sum.fmv + cents(displayMarketPrice(usd, fx, 1)),
        display:
          sum.display +
          cents(
            displayMarketPrice(
              usd,
              fx,
              toMoney(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
            ),
          ),
      };
    },
    { fmv: 0, display: 0 },
  );

  const [summary, ladderRows, stateRow] = await Promise.all([
    packs.creditSummary(id),
    packs.listVipLevels(
      {},
      { select: ['level', 'spend_threshold'], take: 1000 },
    ),
    packs.listVipMemberStates({ customer_id: id }, { take: 1 }).then(
      ([row]) => row ?? null,
    ),
  ]);

  const ladder = ladderRows.map((r) => ({
    level: r.level,
    spend_threshold: Number(r.spend_threshold),
  }));
  const spend = summary.vipSpendTotal;
  const liveLevel =
    ladder.length > 0 ? levelForSpend(spend, ladder) : null;

  let vip: {
    level: number;
    highest_level_ever: number;
    spend: number;
    next: { level: number; threshold: number; remaining: number } | null;
  } | null = null;

  if (liveLevel !== null) {
    // Prefer the vip_member_state projection when the saga has written one.
    const level = stateRow ? Number(stateRow.current_level) : liveLevel;
    const highest = stateRow
      ? Number(stateRow.highest_level_ever)
      : liveLevel;
    // Next rung — null at the top of the ladder. Same computation as
    // GET /store/vip (minus the reward columns this route doesn't select).
    const nextRung = ladder.find((r) => r.level === level + 1) ?? null;
    vip = {
      level,
      highest_level_ever: highest,
      spend,
      next: nextRung
        ? {
            level: nextRung.level,
            threshold: nextRung.spend_threshold,
            remaining: Math.max(0, nextRung.spend_threshold - spend),
          }
        : null,
    };
  }

  res.json({
    customer: {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name ?? null,
      created_at: customer.created_at,
    },
    balance,
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      reason: t.reason,
      reference: t.reference ?? null,
      created_at: t.created_at,
    })),
    pulls: pulls.map((p) => {
      const card = byHandle.get(p.card_id);
      return {
        id: p.id,
        pack_id: p.pack_id,
        rolled_at: p.rolled_at,
        status: p.status,
        buyback_amount:
          p.buyback_amount === null ? null : Number(p.buyback_amount),
        card: card
          ? {
              handle: card.handle,
              name: card.name,
              market_value: displayMarketPrice(toMoney(card.market_value), fx, 1),
              image: card.image,
            }
          : null,
      };
    }),
    vault: {
      count: vaulted.length,
      market_value: vaultCents.fmv / 100,
      display_value: vaultCents.display / 100,
    },
    vip,
  });
}
