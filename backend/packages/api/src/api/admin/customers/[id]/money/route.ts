import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { statsWindows } from '../../../../../modules/packs/stats';
import { resolveFxRate } from '../../../../../modules/packs/pricing';
import {
  customerPeriod,
  playReturn,
  profitActivity,
  profitCash,
  profitOwed,
} from '../../../../../modules/packs/profit';

// The Dashboard's presets (MYT, half-open), under the keys the page shows.
const WINDOWS = [
  ['today', 'today'],
  ['d7', '7d'],
  ['month', 'month'],
] as const;

// GET /admin/customers/:id/money — the player page's money card: one
// customer's top-ups and withdrawals today, over the last 7 days, this month
// and all time (from the credit ledger, the Players list's own sums), and
// where the house stands with them: the Profit report's cash kept and still
// owed (spec 2026-10-14-admin-finance-pages §4.2), run for this customer
// alone, plus their play. Read-only.
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

  const now = new Date();
  const windows = WINDOWS.map(([key, range]) => {
    // Fixed presets: statsWindows answers every one of them.
    const w = statsWindows(range, now)!.current;
    return { key, from: w.from, to: w.to };
  });

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const filter = { customerId: id };
  // One after the other, not Promise.all: each statement takes a connection
  // from the small pool the storefront shares (the profit-report rule).
  const fx = await resolveFxRate(packs);
  const money = await packs.customerMoney(id, windows, fx);
  const cash = await packs.profitCashTotals(null, filter);
  const owed = await packs.profitOwed(filter, fx);
  const reasons = await packs.ledgerReasonTotals(undefined, undefined, filter);
  // The wallet as the player's withdraw button sees it: the same gate
  // (freeze, never topped up, bonus, deposits not yet played through).
  const wallet = await packs.walletSummary(id);

  const activity = profitActivity(reasons);
  const cardsWon = money.cardsWon.cents / 100;
  res.json({
    as_of: now,
    customer_id: id,
    windows: Object.fromEntries(
      windows.map((w) => [w.key, { from: w.from, to: w.to }]),
    ),
    periods: Object.fromEntries(
      Object.entries(money.periods).map(([k, p]) => [k, customerPeriod(p)]),
    ),
    last: {
      topup_at: money.lastTopupAt,
      withdrawal_at: money.lastWithdrawalAt,
      open_at: money.lastOpenAt,
    },
    wallet: {
      balance: wallet.balance,
      withdrawable: wallet.withdrawable,
      bonus: wallet.bonus,
      frozen: wallet.isFrozen,
      has_topup: wallet.hasTopup,
      playthrough: wallet.playthrough,
    },
    cash: profitCash(cash.allTime, null),
    owed: profitOwed(owed, cash.allTime),
    activity,
    play: {
      cards_won: { count: money.cardsWon.count, value: cardsWon },
      return_pct: playReturn(activity.pack_sales, cardsWon),
    },
  });
}
